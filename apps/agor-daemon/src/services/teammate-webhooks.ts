/**
 * Teammate webhook services. Mirrors `services/schedules.ts`; RBAC is wired in
 * `register-hooks.ts`. A webhook runs as its creator, so every write needs the
 * branch Manager tier:
 *   - find:    view (scopeTeammateWebhookQuery)
 *   - get:     view
 *   - create:  all, Member, teammate branch only
 *   - patch:   all, creator only
 *   - remove:  all
 *   - token:   all, creator only (issue or rotate the ingress secret)
 * The worker re-checks the creator's authority at every delivery.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getDaemonBaseUrl, PAGINATION } from '@agor/core/config';
import {
  BranchRepository,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, NotFound } from '@agor/core/feathers';
import { validateTeammateWebhookPromptTemplate } from '@agor/core/templates/teammate-webhook-prompt';
import {
  type AuthenticatedParams,
  type Branch,
  type BranchID,
  isTeammate,
  type PaginatedResult,
  type PersistedScheduleAgenticToolConfig,
  type QueryParams,
  TEAMMATE_WEBHOOK_CREATE_WRITE_FIELDS,
  TEAMMATE_WEBHOOK_PATCH_WRITE_FIELDS,
  TEAMMATE_WEBHOOK_TOKEN_PREFIX,
  TEAMMATE_WEBHOOKS_SERVICE,
  type TeammateWebhook,
  type TeammateWebhookCreateData,
  type TeammateWebhookDelivery,
  type TeammateWebhookDeliveryID,
  type TeammateWebhookID,
  type TeammateWebhookIssuedToken,
  type TeammateWebhookPatchData,
  teammateWebhookIngressUrl,
  type UserID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  normalizeUnattendedRunConfig,
  validateUnattendedRunConfig,
  validateUnattendedRunMcpServers,
} from '../utils/unattended-run-config-validation.js';
import { assertServiceWriteFields, pickWriteFields } from '../utils/write-data-boundary.js';

/** No `update`: whole-row PUT never reaches the inherited DrizzleService implementation. */
export const TEAMMATE_WEBHOOKS_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
] as const;

export type TeammateWebhookParams = QueryParams<{
  branch_id?: BranchID;
  enabled?: boolean;
}> &
  AuthenticatedParams & { teammateWebhook?: TeammateWebhook; branch?: Branch };

type PersistedWebhookWriteData = Partial<
  Omit<TeammateWebhookCreateData, 'agentic_tool_config'> & {
    agentic_tool_config: PersistedScheduleAgenticToolConfig;
    created_by: TeammateWebhook['created_by'];
  }
>;

function assertTemplate(prompt: unknown): void {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new BadRequest('Webhook prompt template cannot be empty.');
  }
  const validation = validateTeammateWebhookPromptTemplate(prompt);
  if (!validation.ok) throw new BadRequest(validation.message);
}

export class TeammateWebhooksService extends DrizzleService<
  TeammateWebhook,
  PersistedWebhookWriteData,
  TeammateWebhookParams
> {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly webhooks = new TeammateWebhookRepository(db)
  ) {
    super(webhooks, {
      id: 'webhook_id',
      resourceType: 'TeammateWebhook',
      paginate: { default: PAGINATION.DEFAULT_LIMIT, max: PAGINATION.MAX_LIMIT },
    });
  }

  protected async fetchData(query: Record<string, unknown>): Promise<TeammateWebhook[]> {
    const branchId =
      typeof query.branch_id === 'string' ? (query.branch_id as BranchID) : undefined;
    return this.webhooks.findAll(branchId ? { branch_id: branchId } : undefined);
  }

  async create(data: TeammateWebhookCreateData, params?: TeammateWebhookParams) {
    const rawData = data as unknown as Record<string, unknown>;
    const prepared = assertServiceWriteFields(
      'TeammateWebhook',
      rawData,
      TEAMMATE_WEBHOOK_CREATE_WRITE_FIELDS,
      params,
      ['created_by']
    );
    data = pickWriteFields<TeammateWebhookCreateData>(
      rawData,
      TEAMMATE_WEBHOOK_CREATE_WRITE_FIELDS
    );
    const createdBy = (params?.user?.user_id ?? (prepared ? rawData.created_by : undefined)) as
      | UserID
      | undefined;
    if (!createdBy) throw new BadRequest('Teammate webhooks need a creator to run as.');
    if (!data.name?.trim()) throw new BadRequest('Webhook name cannot be empty.');
    assertTemplate(data.prompt);
    if (!data.agentic_tool_config) throw new BadRequest('Webhook agentic_tool_config is required.');

    const branch =
      params?.branch?.branch_id === data.branch_id
        ? params.branch
        : await new BranchRepository(this.db).findById(data.branch_id);
    if (!branch) throw new NotFound(`Branch not found: ${data.branch_id}`);
    // Branch metadata is client-editable, so the teammate gate is enforced here, not in the UI.
    if (!isTeammate(branch)) {
      throw new BadRequest('Webhooks can only be created on a teammate branch.');
    }

    const agenticToolConfig = await validateUnattendedRunConfig(
      this.db,
      normalizeUnattendedRunConfig(data.agentic_tool_config),
      createdBy
    );
    if (data.mcp_server_ids?.length) {
      await validateUnattendedRunMcpServers(
        this.db,
        data.mcp_server_ids,
        createdBy,
        'Teammate webhooks'
      );
    }
    return super.create(
      { ...data, agentic_tool_config: agenticToolConfig, created_by: createdBy },
      params
    );
  }

  async patch(id: string | null, data: TeammateWebhookPatchData, params?: TeammateWebhookParams) {
    if (id === null) throw new BadRequest('Teammate webhooks cannot be multi-patched');
    const rawData = data as Record<string, unknown>;
    assertServiceWriteFields(
      'TeammateWebhook',
      rawData,
      TEAMMATE_WEBHOOK_PATCH_WRITE_FIELDS,
      params
    );
    data = pickWriteFields<TeammateWebhookPatchData>(rawData, TEAMMATE_WEBHOOK_PATCH_WRITE_FIELDS);
    if (data.name !== undefined && !data.name.trim()) {
      throw new BadRequest('Webhook name cannot be empty.');
    }
    if (data.prompt !== undefined) assertTemplate(data.prompt);

    const current = params?.teammateWebhook ?? (await this.get(id, params));
    const runAs = current.created_by as UserID;
    const agenticToolConfig = data.agentic_tool_config
      ? await validateUnattendedRunConfig(
          this.db,
          normalizeUnattendedRunConfig(data.agentic_tool_config),
          runAs
        )
      : undefined;
    if (data.mcp_server_ids?.length) {
      await validateUnattendedRunMcpServers(
        this.db,
        data.mcp_server_ids,
        runAs,
        'Teammate webhooks'
      );
    }
    return super.patch(
      id,
      { ...data, ...(agenticToolConfig ? { agentic_tool_config: agenticToolConfig } : {}) },
      params
    );
  }
}

/** Display prefix: the scheme marker plus four random characters. */
const TOKEN_HINT_LENGTH = TEAMMATE_WEBHOOK_TOKEN_PREFIX.length + 4;

export function hashTeammateWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type TeammateWebhookTokenParams = AuthenticatedParams & {
  route?: { id?: string };
  teammateWebhook?: TeammateWebhook;
};

/**
 * `teammate-webhooks/:id/token` create: issue or rotate the ingress secret.
 * The plaintext exists only in this response. Its realtime audience is
 * `'none'`; the webhook row change is published as a token-free `patched`.
 */
export class TeammateWebhookTokenService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly app: Application,
    private readonly webhooks = new TeammateWebhookRepository(db)
  ) {}

  async create(
    _data: unknown,
    params?: TeammateWebhookTokenParams
  ): Promise<TeammateWebhookIssuedToken> {
    const id = params?.route?.id;
    if (!id) throw new BadRequest('Webhook ID required');
    const webhook = params?.teammateWebhook ?? (await this.webhooks.findById(id));
    if (!webhook) throw new NotFound(`Teammate webhook not found: ${id}`);

    const token = `${TEAMMATE_WEBHOOK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const tokenHint = token.slice(0, TOKEN_HINT_LENGTH);
    const updated = await this.webhooks.setTokenHash(
      webhook.webhook_id,
      hashTeammateWebhookToken(token),
      tokenHint
    );
    emitServiceEvent(this.app, {
      path: TEAMMATE_WEBHOOKS_SERVICE,
      event: 'patched',
      data: updated,
      id: updated.webhook_id,
      params: params as never,
    });
    return {
      webhook_id: updated.webhook_id,
      token,
      token_hint: tokenHint,
      ingress_url: teammateWebhookIngressUrl(await getDaemonBaseUrl(this.db), updated.webhook_id),
    };
  }
}

export type TeammateWebhookDeliveryParams = QueryParams<{ webhook_id?: TeammateWebhookID }> &
  AuthenticatedParams & { teammateWebhook?: TeammateWebhook };

/** Read-only delivery history. Payloads never leave the repository. */
export class TeammateWebhookDeliveriesService {
  constructor(private readonly deliveries: TeammateWebhookDeliveryRepository) {}

  async find(
    params?: TeammateWebhookDeliveryParams
  ): Promise<PaginatedResult<TeammateWebhookDelivery>> {
    const query = (params?.query ?? {}) as Record<string, unknown>;
    const webhookId = query.webhook_id;
    if (typeof webhookId !== 'string' || !webhookId) {
      throw new BadRequest('webhook_id is required');
    }
    const limit = Number(query.$limit ?? PAGINATION.DEFAULT_LIMIT);
    const skip = Number(query.$skip ?? 0);
    return this.deliveries.findByWebhook(webhookId as TeammateWebhookID, {
      limit: Number.isFinite(limit) ? limit : undefined,
      skip: Number.isFinite(skip) ? skip : undefined,
    });
  }

  async get(id: string): Promise<TeammateWebhookDelivery> {
    const delivery = await this.deliveries.findById(id as TeammateWebhookDeliveryID);
    if (!delivery) throw new NotFound(`Webhook delivery not found: ${id}`);
    return delivery;
  }
}

export function createTeammateWebhookServices(db: TenantScopeAwareDatabase, app: Application) {
  return {
    webhooks: new TeammateWebhooksService(db),
    token: new TeammateWebhookTokenService(db, app),
    deliveries: new TeammateWebhookDeliveriesService(new TeammateWebhookDeliveryRepository(db)),
  };
}
