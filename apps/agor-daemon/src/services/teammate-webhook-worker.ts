/**
 * Teammate webhook worker: turns admitted deliveries into unattended runs.
 *
 * One serial lane per webhook on the shared `GatewayDeliveryLoop`. Each pass
 * claims the lane head (strict FIFO unless the webhook allows concurrent runs),
 * then: decrypt the payload, re-read the webhook, re-check that its branch is a
 * teammate, render the prompt, run the shared run-as gate, admit the Session
 * with an id derived from the delivery, attach MCP servers, and dispatch the
 * first Task with an id derived the same way. Both ids are derived, so a
 * retry after a crash at any step converges on one Session and one Task.
 *
 * Permanent refusals fail the delivery with a typed code. Everything else is
 * transient and retried with backoff until the attempt budget runs out.
 */

import { isMCPServerNotUsableError } from '@agor/core';
import { analyticsLogger } from '@agor/core/analytics';
import {
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  getCurrentTenantId,
  isDatabaseUniqueConstraintError,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  type TeammateWebhookDeliveryClaim,
  TeammateWebhookDeliveryRepository,
  type TeammateWebhookDueRef,
  TeammateWebhookPayloadUnreadableError,
  TeammateWebhookRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import {
  renderTeammateWebhookPrompt,
  TeammateWebhookTemplateRenderError,
} from '@agor/core/templates/teammate-webhook-prompt';
import {
  isTeammate,
  type Session,
  type Task,
  TEAMMATE_WEBHOOK_DELIVERIES_SERVICE,
  type TeammateWebhookFailureCode,
  type TenantID,
} from '@agor/core/types';
import type { Application } from '../declarations';
import { buildSessionCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { teammateWebhookSessionId, teammateWebhookTaskId } from '../utils/durable-task-id.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  formatStructuredLog,
  type StructuredLogValue,
  structuredLogErrorCode,
} from '../utils/structured-log.js';
import {
  boundedBackoff,
  discoverDueDeliveryRefs,
  GatewayDeliveryLoop,
} from './gateway-delivery-loop.js';
import {
  admitUnattendedSessionRow,
  attachUnattendedMcpServers,
  createUnattendedRunDeps,
  dispatchUnattendedPrompt,
  prepareUnattendedRun,
  type UnattendedRunConfig,
  type UnattendedRunDeps,
  type UnattendedRunRejection,
  UnattendedRunRevokedError,
} from './unattended-run.js';

const AREA = 'distributed-work.teammate-webhooks';
const SCAN_BATCH = 25;
const MAX_CONCURRENCY = 4;
const LOOP_INTERVAL_MS = 1_000;
const MAX_IDLE_DELAY_MS = 30_000;
const DRAIN_TIMEOUT_MS = 5_000;
const LEASE_MS = 5 * 60_000;
/** How often a blocked FIFO lane re-checks whether the previous run finished. */
const BUSY_DELAY_MS = 15_000;
const MAX_CLAIMS_PER_PASS = 10;
export const TEAMMATE_WEBHOOK_MAX_ATTEMPTS = 8;

type DiscoveryDatabase = Parameters<TeammateWebhookDeliveryRepository['findDueWebhookRefs']>[0];

/** A refusal that no retry can fix. */
class PermanentDeliveryFailure extends Error {
  constructor(readonly code: TeammateWebhookFailureCode) {
    super(`Teammate webhook delivery failed: ${code}`);
    this.name = 'PermanentDeliveryFailure';
  }
}

const REJECTION_FAILURE_CODES: Record<UnattendedRunRejection['code'], TeammateWebhookFailureCode> =
  {
    branch_missing: 'branch_not_teammate',
    permission_revoked: 'permission_revoked',
    creator_missing: 'creator_unavailable',
    creator_home_key_missing: 'creator_unavailable',
    agentic_tool_removed: 'agentic_tool_removed',
    invalid_config: 'invalid_config',
    tool_unavailable: 'tool_unavailable',
  };

export interface TeammateWebhookWorkerTestHooks {
  afterSessionAdmission?(session: Session): Promise<void> | void;
  afterMcpAttachments?(session: Session): Promise<void> | void;
  afterPromptDispatch?(task: Task): Promise<void> | void;
}

export interface TeammateWebhookWorkerOptions {
  runConfig: UnattendedRunConfig;
  /** Static/single-tenant id. Undefined discovers due tenants under the delivery capability. */
  tenantId?: TenantID | string;
  random?: () => number;
  testHooks?: TeammateWebhookWorkerTestHooks;
}

export class TeammateWebhookWorker {
  private readonly loop: GatewayDeliveryLoop<TeammateWebhookDueRef>;
  private readonly runDeps: UnattendedRunDeps;
  private readonly deliveries: TeammateWebhookDeliveryRepository;
  private readonly webhooks: TeammateWebhookRepository;
  private readonly branches: BranchRepository;
  private readonly sessions: SessionRepository;
  private readonly tasks: TaskRepository;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly options: TeammateWebhookWorkerOptions
  ) {
    this.runDeps = createUnattendedRunDeps(db, app, options.runConfig);
    const bind = <T extends object>(repository: T): T =>
      bindRepositoryToTenantUnitOfWork(db, repository);
    this.deliveries = bind(new TeammateWebhookDeliveryRepository(db));
    this.webhooks = bind(new TeammateWebhookRepository(db));
    this.branches = bind(new BranchRepository(db));
    this.sessions = bind(new SessionRepository(db));
    this.tasks = bind(new TaskRepository(db));
    this.loop = new GatewayDeliveryLoop<TeammateWebhookDueRef>({
      area: AREA,
      tenantId: options.tenantId,
      scanBatchSize: SCAN_BATCH,
      maxConcurrency: MAX_CONCURRENCY,
      shutdownTimeoutMs: DRAIN_TIMEOUT_MS,
      recoveryIntervalMs: LOOP_INTERVAL_MS,
      maxIdleDelayMs: MAX_IDLE_DELAY_MS,
      random: options.random ?? Math.random,
      discover: (limit) =>
        discoverDueDeliveryRefs(db, {
          tenantId: options.tenantId,
          label: 'teammate webhook delivery discovery',
          capability: 'teammate_webhook_delivery_discovery',
          find: (scoped) => {
            const handle = scoped as DiscoveryDatabase;
            return new TeammateWebhookDeliveryRepository(handle).findDueWebhookRefs(handle, {
              limit,
            });
          },
        }),
      lane: (ref) => `webhook:${ref.webhook_id}`,
      process: (ref) => this.drainWebhook(ref),
      purge: () => this.deliveries.purge(),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Claim newly admitted local deliveries now instead of waiting out the idle back-off. */
  wake(): void {
    this.loop.wake();
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  checkOnce(): Promise<number> {
    return this.loop.checkOnce();
  }

  private log(level: 'info' | 'warn', event: string, fields: Record<string, StructuredLogValue>) {
    const line = formatStructuredLog(`[${AREA}]`, {
      event,
      tenant_id: getCurrentTenantId(),
      ...fields,
    });
    if (level === 'warn') console.warn(line);
    else console.info(line);
  }

  private async drainWebhook(ref: TeammateWebhookDueRef): Promise<void> {
    for (let claims = 0; claims < MAX_CLAIMS_PER_PASS; claims += 1) {
      const result = await this.deliveries.claimNext(ref.webhook_id, {
        leaseMs: LEASE_MS,
        busyDelayMs: BUSY_DELAY_MS,
      });
      if (result.kind !== 'claimed') return;
      await this.settle(result.claim);
    }
  }

  private async settle(claim: TeammateWebhookDeliveryClaim): Promise<void> {
    const ids = { delivery_id: claim.delivery_id, webhook_id: claim.webhook_id };
    try {
      const outcome = await this.runDelivery(claim);
      if (outcome.fenceLost) {
        this.log('warn', 'claim_lost', ids);
        return;
      }
      this.log('info', 'delivery_started', {
        ...ids,
        session_id: outcome.sessionId,
        task_id: outcome.taskId,
      });
    } catch (error) {
      const attempt = claim.attempt_count + 1;
      const code =
        error instanceof PermanentDeliveryFailure
          ? error.code
          : attempt >= TEAMMATE_WEBHOOK_MAX_ATTEMPTS
            ? 'retries_exhausted'
            : null;
      if (code) {
        await this.deliveries.markFailed(claim, code);
        this.log('warn', 'delivery_failed', { ...ids, code, attempt });
      } else {
        const delayMs = boundedBackoff(attempt);
        await this.deliveries.deferRetry(claim, delayMs);
        this.log('warn', 'delivery_retry_scheduled', {
          ...ids,
          attempt,
          delay_ms: delayMs,
          code: structuredLogErrorCode(error),
        });
      }
    }
    await this.publish(claim);
  }

  private async publish(claim: TeammateWebhookDeliveryClaim): Promise<void> {
    const delivery = await this.deliveries.findById(claim.delivery_id);
    if (!delivery) return;
    emitServiceEvent(this.app, {
      path: TEAMMATE_WEBHOOK_DELIVERIES_SERVICE,
      event: 'patched',
      data: delivery,
      id: delivery.delivery_id,
    });
  }

  private async runDelivery(
    claim: TeammateWebhookDeliveryClaim
  ): Promise<{ fenceLost: true } | { fenceLost: false; sessionId: string; taskId: string }> {
    let payload: unknown;
    try {
      payload = await this.deliveries.decryptPayload(claim);
    } catch (error) {
      if (error instanceof TeammateWebhookPayloadUnreadableError) {
        throw new PermanentDeliveryFailure('payload_unreadable');
      }
      throw error;
    }
    const webhook = await this.webhooks.findById(claim.webhook_id);
    if (!webhook?.enabled) throw new PermanentDeliveryFailure('webhook_disabled');
    // Branch metadata is editable, so teammate status is re-checked at every run.
    const branch = await this.branches.findById(webhook.branch_id);
    if (!branch || !isTeammate(branch)) throw new PermanentDeliveryFailure('branch_not_teammate');

    let prompt: string;
    try {
      prompt = renderTeammateWebhookPrompt({
        template: webhook.prompt,
        webhook: { webhook_id: webhook.webhook_id, name: webhook.name },
        branch: {
          name: branch.name,
          ref: branch.ref,
          issue_url: branch.issue_url,
          pull_request_url: branch.pull_request_url,
        },
        delivery: { delivery_id: claim.delivery_id, received_at: claim.received_at },
        payload,
      });
    } catch (error) {
      if (error instanceof TeammateWebhookTemplateRenderError) {
        throw new PermanentDeliveryFailure('template_render_failed');
      }
      throw error;
    }

    const prepared = await prepareUnattendedRun(this.runDeps, {
      branchId: webhook.branch_id,
      runAsUserId: webhook.created_by,
      agenticToolConfig: webhook.agentic_tool_config,
      mcpServerIds: webhook.mcp_server_ids,
    });
    if (!prepared.ok) {
      throw new PermanentDeliveryFailure(REJECTION_FAILURE_CODES[prepared.rejection.code]);
    }
    const { run } = prepared;

    const sessionId = teammateWebhookSessionId(claim.delivery_id);
    const taskId = teammateWebhookTaskId(claim.delivery_id);
    const admitSession = () =>
      runWithTenantDatabaseScope(this.db, getCurrentTenantId(), async () => {
        const existing = await this.sessions.findById(sessionId);
        if (existing) return { created: false, session: existing };
        let row: Partial<Session>;
        try {
          row = await admitUnattendedSessionRow(this.runDeps, run, {
            sessionId,
            title: `${webhook.name} — ${claim.received_at}`,
            extra: {},
          });
        } catch (error) {
          // The branch SDK home cannot host this tool; no retry changes that.
          if (error instanceof BadRequest) throw new PermanentDeliveryFailure('tool_unavailable');
          throw error;
        }
        return { created: true, session: await this.sessions.create(row) };
      });
    let admission: { created: boolean; session: Session };
    try {
      admission = await admitSession();
    } catch (error) {
      if (!isDatabaseUniqueConstraintError(error)) throw error;
      const winner = await this.sessions.findById(sessionId);
      if (!winner) throw error;
      admission = { created: false, session: winner };
    }
    const { session } = admission;
    if (!(await this.deliveries.recordSession(claim, sessionId))) return { fenceLost: true };
    if (admission.created) {
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'created',
        data: session,
        id: session.session_id,
      });
      analyticsLogger.track('session.created', buildSessionCreatedAnalyticsProperties(session), {
        userId: session.created_by,
      });
    }
    await this.options.testHooks?.afterSessionAdmission?.(session);

    try {
      await attachUnattendedMcpServers(this.runDeps, {
        sessionId,
        mcpServerIds: run.mcpServerIds,
        onMissingServer: (mcpServerId) =>
          this.log('warn', 'mcp_attachment_missing', {
            delivery_id: claim.delivery_id,
            session_id: sessionId,
            mcp_server_id: mcpServerId,
          }),
      });
    } catch (error) {
      if (isMCPServerNotUsableError(error)) throw new PermanentDeliveryFailure('invalid_config');
      throw error;
    }
    await this.options.testHooks?.afterMcpAttachments?.(session);

    let task: Task;
    try {
      task = await dispatchUnattendedPrompt(this.runDeps, {
        session,
        creator: run.creator,
        prompt,
        taskId,
        taskAlreadyAdmitted: (await this.tasks.findById(taskId)) !== null,
      });
    } catch (error) {
      if (error instanceof UnattendedRunRevokedError) {
        throw new PermanentDeliveryFailure('permission_revoked');
      }
      throw error;
    }
    await this.options.testHooks?.afterPromptDispatch?.(task);

    if (!(await this.deliveries.markStarted(claim, task.task_id))) return { fenceLost: true };
    return { fenceLost: false, sessionId, taskId: task.task_id };
  }
}
