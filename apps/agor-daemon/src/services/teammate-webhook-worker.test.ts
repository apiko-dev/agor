import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  generateId,
  RepoRepository,
  runWithTenantContext,
  SessionRepository,
  select,
  TaskRepository,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
  teammateWebhookDeliveries,
  UsersRepository,
  update,
} from '@agor/core/db';
import { TEAMMATE_WEBHOOK_UNTRUSTED_PREAMBLE } from '@agor/core/templates/teammate-webhook-prompt';
import {
  type BranchID,
  type Task,
  TaskStatus,
  type TeammateWebhook,
  type TeammateWebhookDelivery,
  type TeammateWebhookDeliveryID,
  type User,
} from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { teammateWebhookSessionId, teammateWebhookTaskId } from '../utils/durable-task-id.js';
import {
  TeammateWebhookWorker,
  type TeammateWebhookWorkerOptions,
  type TeammateWebhookWorkerTestHooks,
} from './teammate-webhook-worker';
import type { UnattendedRunConfig } from './unattended-run';

const RUN_CONFIG: UnattendedRunConfig = {
  unixUserMode: 'simple',
  sdkHomeMode: 'inherit',
  deploymentPolicy: { managed: false, installed: new Set() },
  deploymentToolUnsupported: () => undefined,
  hostedOpenCode: false,
  secureLocalCredentialOverlay: false,
};

async function seed(db: Database, webhook: Partial<TeammateWebhook> = {}) {
  const creator = await new UsersRepository(db).create({
    email: `creator-${generateId()}@example.com`,
    name: 'Creator',
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `webhook-worker-${generateId()}`,
    name: 'Webhook worker',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'jira-teammate',
    ref: 'jira-teammate',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: creator.user_id,
    custom_context: { teammate: { kind: 'teammate' } },
  });
  const created = await new TeammateWebhookRepository(db).create({
    branch_id: branch.branch_id,
    created_by: creator.user_id,
    name: 'Jira triage',
    prompt: 'Triage {{payload.issue.key}}',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    ...webhook,
  });
  return { creator, branch, webhook: created };
}

async function admit(db: Database, webhookId: TeammateWebhook['webhook_id'], payload: unknown) {
  const result = await new TeammateWebhookDeliveryRepository(db).admit({
    webhookId,
    idempotencyKey: null,
    payload,
    payloadBytes: JSON.stringify(payload).length,
  });
  if (result.outcome === 'rejected') throw new Error(`not admitted: ${result.reason}`);
  return result.delivery;
}

function createWorkerApp(db: Database) {
  const tasks = new TaskRepository(db);
  const prompt = vi.fn(
    async (data: { prompt: string; idempotencyTaskId: string }, params: any): Promise<Task> => {
      const existing = await tasks.findById(data.idempotencyTaskId);
      if (existing) return existing;
      return tasks.create({
        task_id: data.idempotencyTaskId as Task['task_id'],
        session_id: params.route.id,
        created_by: params.user.user_id,
        full_prompt: data.prompt,
        status: TaskStatus.RUNNING,
      });
    }
  );
  const events: Array<{ path: string; event: string; data: unknown }> = [];
  const emitter = (path: string) => ({
    emit: (event: string, data: unknown) => events.push({ path, event, data }),
  });
  const app = {
    get: () => undefined,
    service: (path: string) =>
      path === '/sessions/:id/prompt' ? { create: prompt } : emitter(path),
  } as unknown as ConstructorParameters<typeof TeammateWebhookWorker>[1];
  return { app, prompt, events };
}

function worker(
  db: Database,
  app: ConstructorParameters<typeof TeammateWebhookWorker>[1],
  options: Partial<TeammateWebhookWorkerOptions> & {
    testHooks?: TeammateWebhookWorkerTestHooks;
  } = {}
) {
  return new TeammateWebhookWorker(createTenantScopedDatabaseProxy(db), app, {
    runConfig: RUN_CONFIG,
    tenantId: 'default',
    ...options,
  });
}

const run = (w: TeammateWebhookWorker) => runWithTenantContext('default', () => w.checkOnce());

async function delivery(db: Database, id: TeammateWebhookDeliveryID) {
  return (await new TeammateWebhookDeliveryRepository(db).findById(id)) as TeammateWebhookDelivery;
}

/** Stand in for time passing: make every waiting delivery due now. */
async function makeDue(db: Database) {
  await update(db, teammateWebhookDeliveries)
    .set({ next_attempt_at: new Date(Date.now() - 1_000) })
    .run();
}

async function storedPayload(db: Database, id: TeammateWebhookDeliveryID) {
  const row = await select(db, { payload: teammateWebhookDeliveries.payload_encrypted })
    .from(teammateWebhookDeliveries)
    .where(eq(teammateWebhookDeliveries.delivery_id, id))
    .one();
  return row?.payload ?? null;
}

describe('teammate webhook worker', () => {
  dbTest('starts one session and task with ids derived from the delivery', async ({ db }) => {
    const { creator, branch, webhook } = await seed(db);
    const admitted = await admit(db, webhook.webhook_id, { issue: { key: 'PROJ-42' } });
    const { app, prompt, events } = createWorkerApp(db);

    await run(worker(db, app));

    const sessionId = teammateWebhookSessionId(admitted.delivery_id);
    const taskId = teammateWebhookTaskId(admitted.delivery_id);
    expect(await delivery(db, admitted.delivery_id)).toMatchObject({
      status: 'started',
      session_id: sessionId,
      task_id: taskId,
    });
    expect(await storedPayload(db, admitted.delivery_id)).toBeNull();
    const session = await new SessionRepository(db).findById(sessionId);
    expect(session).toMatchObject({
      branch_id: branch.branch_id,
      created_by: creator.user_id,
      title: `Jira triage — ${admitted.received_at}`,
    });
    expect(prompt).toHaveBeenCalledOnce();
    const [data, params] = prompt.mock.calls[0];
    expect(data.prompt.startsWith(TEAMMATE_WEBHOOK_UNTRUSTED_PREAMBLE)).toBe(true);
    expect(data.prompt).toContain('Triage "PROJ-42"');
    expect(params.user.user_id).toBe(creator.user_id);
    expect(events.map((e) => `${e.path}.${e.event}`)).toEqual([
      'sessions.created',
      'teammate-webhook-deliveries.patched',
    ]);
    expect(JSON.stringify(events)).not.toContain('PROJ-42');
  });

  for (const stage of [
    'afterSessionAdmission',
    'afterMcpAttachments',
    'afterPromptDispatch',
  ] as const) {
    dbTest(`converges on one session and one task after a failure at ${stage}`, async ({ db }) => {
      const { branch, webhook } = await seed(db);
      const admitted = await admit(db, webhook.webhook_id, { issue: { key: 'PROJ-7' } });
      const { app, prompt } = createWorkerApp(db);

      await run(
        worker(db, app, {
          testHooks: {
            [stage]: () => {
              throw new Error(`simulated kill at ${stage}`);
            },
          },
        })
      );
      expect(await delivery(db, admitted.delivery_id)).toMatchObject({
        status: 'queued',
        defer_reason: 'transient_retry',
        attempt_count: 1,
      });

      await makeDue(db);
      await run(worker(db, app));

      expect(await delivery(db, admitted.delivery_id)).toMatchObject({ status: 'started' });
      const sessions = await new SessionRepository(db).findAll({ branchId: branch.branch_id });
      expect(sessions.map((s) => s.session_id)).toEqual([
        teammateWebhookSessionId(admitted.delivery_id),
      ]);
      const tasks = await new TaskRepository(db).findBySession(sessions[0].session_id);
      expect(tasks.map((t) => t.task_id)).toEqual([teammateWebhookTaskId(admitted.delivery_id)]);
      expect(new Set(prompt.mock.calls.map(([data]) => data.idempotencyTaskId)).size).toBe(1);
    });
  }

  dbTest('reclaims a delivery whose worker died holding the lease', async ({ db }) => {
    const { webhook } = await seed(db);
    const admitted = await admit(db, webhook.webhook_id, { issue: { key: 'PROJ-9' } });
    const claim = await new TeammateWebhookDeliveryRepository(db).claimNext(webhook.webhook_id, {
      leaseMs: 60_000,
      busyDelayMs: 1_000,
    });
    expect(claim.kind).toBe('claimed');
    await update(db, teammateWebhookDeliveries)
      .set({ processing_expires_at: new Date(Date.now() - 1_000) })
      .run();
    const { app } = createWorkerApp(db);

    await run(worker(db, app));

    expect(await delivery(db, admitted.delivery_id)).toMatchObject({ status: 'started' });
  });

  dbTest(
    'runs deliveries one at a time, in arrival order, unless concurrency is allowed',
    async ({ db }) => {
      const { webhook } = await seed(db, { prompt: 'Run {{payload.n}}' });
      const [first, second, third] = [
        await admit(db, webhook.webhook_id, { n: 1 }),
        await admit(db, webhook.webhook_id, { n: 2 }),
        await admit(db, webhook.webhook_id, { n: 3 }),
      ];
      const { app, prompt } = createWorkerApp(db);
      const w = worker(db, app);

      await run(w);
      expect((await delivery(db, first.delivery_id)).status).toBe('started');
      for (const waiting of [second, third]) {
        expect(await delivery(db, waiting.delivery_id)).toMatchObject({
          status: 'queued',
          defer_reason: 'busy',
          attempt_count: 0,
        });
      }

      await makeDue(db);
      await run(w);
      expect((await delivery(db, second.delivery_id)).status).toBe('queued');

      await new TaskRepository(db).update(teammateWebhookTaskId(first.delivery_id), {
        status: TaskStatus.COMPLETED,
      });
      await makeDue(db);
      await run(w);
      expect((await delivery(db, second.delivery_id)).status).toBe('started');
      expect((await delivery(db, third.delivery_id)).status).toBe('queued');
      expect(prompt.mock.calls.map(([data]) => data.prompt.match(/\d+$/)?.[0])).toEqual(['1', '2']);

      await new TeammateWebhookRepository(db).update(webhook.webhook_id, {
        allow_concurrent_runs: true,
      });
      const fourth = await admit(db, webhook.webhook_id, { n: 4 });
      await makeDue(db);
      await run(w);
      expect((await delivery(db, third.delivery_id)).status).toBe('started');
      expect((await delivery(db, fourth.delivery_id)).status).toBe('started');
    }
  );

  describe('permanent failures', () => {
    const cases: Array<{
      code: string;
      setup: (ctx: {
        db: Database;
        creator: User;
        branchId: BranchID;
        webhook: TeammateWebhook;
      }) => Promise<unknown>;
      payload?: unknown;
      webhook?: Partial<TeammateWebhook>;
      runConfig?: Partial<UnattendedRunConfig>;
    }> = [
      {
        code: 'branch_not_teammate',
        setup: ({ db, branchId }) =>
          new BranchRepository(db).update(branchId, {
            custom_context: { teammate: { kind: 'retired' } },
          }),
      },
      {
        code: 'permission_revoked',
        setup: ({ db, creator }) =>
          new UsersRepository(db).update(creator.user_id, { role: 'viewer' }),
      },
      {
        code: 'template_render_failed',
        setup: async () => undefined,
        webhook: { prompt: '{{json payload}}' },
        payload: { blob: 'x'.repeat(200_000) },
      },
      {
        code: 'tool_unavailable',
        setup: async () => undefined,
        runConfig: { deploymentPolicy: { managed: true, installed: new Set() } },
      },
      {
        code: 'webhook_disabled',
        // A delete cascades its deliveries; a lost race leaves the claim without a webhook.
        setup: async () =>
          vi.spyOn(TeammateWebhookRepository.prototype, 'findById').mockResolvedValue(null),
      },
    ];

    for (const testCase of cases) {
      dbTest(`fails the delivery as ${testCase.code} without starting a run`, async ({ db }) => {
        const { creator, branch, webhook } = await seed(db, testCase.webhook);
        const admitted = await admit(db, webhook.webhook_id, testCase.payload ?? { ok: true });
        await testCase.setup({ db, creator, branchId: branch.branch_id, webhook });
        const { app, prompt } = createWorkerApp(db);

        try {
          await run(worker(db, app, { runConfig: { ...RUN_CONFIG, ...testCase.runConfig } }));
        } finally {
          vi.restoreAllMocks();
        }

        expect(await delivery(db, admitted.delivery_id)).toMatchObject({
          status: 'failed',
          failure_code: testCase.code,
        });
        expect(await storedPayload(db, admitted.delivery_id)).toBeNull();
        expect(prompt).not.toHaveBeenCalled();
      });
    }

    dbTest(
      'keeps the session when the creator is revoked before the first task',
      async ({ db }) => {
        const { webhook } = await seed(db);
        const admitted = await admit(db, webhook.webhook_id, { ok: true });
        const { app, prompt } = createWorkerApp(db);

        await run(
          worker(db, app, {
            testHooks: {
              afterMcpAttachments: () => {
                vi.spyOn(
                  BranchRepository.prototype,
                  'resolveSessionPromptAuthority'
                ).mockResolvedValue({ allowed: false } as never);
              },
            },
          })
        );
        vi.restoreAllMocks();

        expect(await delivery(db, admitted.delivery_id)).toMatchObject({
          status: 'failed',
          failure_code: 'permission_revoked',
          session_id: teammateWebhookSessionId(admitted.delivery_id),
        });
        expect(prompt).not.toHaveBeenCalled();
      }
    );

    dbTest('gives up as retries_exhausted after the last transient attempt', async ({ db }) => {
      const { webhook } = await seed(db);
      const admitted = await admit(db, webhook.webhook_id, { ok: true });
      await update(db, teammateWebhookDeliveries).set({ attempt_count: 7 }).run();
      const { app, prompt } = createWorkerApp(db);
      prompt.mockRejectedValue(new Error('executor unavailable'));

      await run(worker(db, app));

      expect(await delivery(db, admitted.delivery_id)).toMatchObject({
        status: 'failed',
        failure_code: 'retries_exhausted',
      });
    });
  });
});
