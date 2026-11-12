/**
 * Teammate webhook definitions. Mirrors the schedule repository.
 *
 * `token_hash` never leaves this module except through
 * {@link TeammateWebhookRepository.findIngressCredential}, so no service
 * result or realtime event can carry it.
 */

import type {
  BranchID,
  PersistedScheduleAgenticToolConfig,
  TeammateWebhook,
  TeammateWebhookID,
  UUID,
} from '@agor/core/types';
import { and, desc, eq, like } from 'drizzle-orm';
import { normalizeScheduleAgenticToolDefaultReference } from '../../config/schedule-agentic-tool-config';
import { generateId } from '../../lib/ids';
import { lockBranchForAdmission } from '../branch-admission';
import type { Database } from '../client';
import {
  deleteFrom,
  getDatabaseNow,
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  branches,
  type TeammateWebhookInsert,
  type TeammateWebhookRow,
  teammateWebhookDeliveries,
  teammateWebhooks,
} from '../schema';
import {
  attachHiddenTenant,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { visibleBranchAccessCondition } from './branch-access';

/** What ingress needs to verify one presented token. Never a domain type. */
export interface TeammateWebhookIngressCredential {
  webhook_id: TeammateWebhookID;
  branch_id: BranchID;
  enabled: boolean;
  token_hash: string | null;
}

export interface TeammateWebhookFilter {
  branch_id?: BranchID;
  enabled?: boolean;
  created_by?: UUID;
}

/** Fields a patch may change. Identity, run-as, and token state are server-owned. */
type TeammateWebhookUpdate = Partial<
  Pick<
    TeammateWebhook,
    | 'name'
    | 'description'
    | 'prompt'
    | 'agentic_tool_config'
    | 'mcp_server_ids'
    | 'enabled'
    | 'allow_concurrent_runs'
  >
>;

function rowToWebhook(row: TeammateWebhookRow): TeammateWebhook {
  const storedConfig =
    typeof row.agentic_tool_config === 'string'
      ? (JSON.parse(row.agentic_tool_config) as PersistedScheduleAgenticToolConfig)
      : (row.agentic_tool_config as PersistedScheduleAgenticToolConfig);
  return attachHiddenTenant(
    {
      webhook_id: row.webhook_id as TeammateWebhookID,
      branch_id: row.branch_id as BranchID,
      name: row.name,
      description: row.description ?? undefined,
      prompt: row.prompt,
      agentic_tool_config: {
        ...storedConfig,
        preset_id:
          (row.agentic_tool_preset_id as PersistedScheduleAgenticToolConfig['preset_id']) ??
          storedConfig.preset_id,
      },
      mcp_server_ids: row.mcp_server_ids ?? undefined,
      enabled: Boolean(row.enabled),
      allow_concurrent_runs: Boolean(row.allow_concurrent_runs),
      token_hint: row.token_hint ?? null,
      token_issued_at: row.token_issued_at ? new Date(row.token_issued_at).toISOString() : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      created_by: row.created_by as UUID,
    },
    row
  );
}

/** Store the preset as a restrictive FK unless it names a default reference. */
function configColumns(config: PersistedScheduleAgenticToolConfig) {
  const { preset_id, ...configWithoutPreset } = config;
  const storesDefaultReference = Boolean(
    preset_id && normalizeScheduleAgenticToolDefaultReference(preset_id)
  );
  return {
    agentic_tool_config: (storesDefaultReference ? config : configWithoutPreset) as unknown,
    agentic_tool_preset_id: storesDefaultReference ? null : (preset_id ?? null),
  };
}

export class TeammateWebhookRepository {
  constructor(private db: Database) {}

  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'TeammateWebhook', async (pattern) => {
      const rows = await select(this.db, { webhook_id: teammateWebhooks.webhook_id })
        .from(teammateWebhooks)
        .where(like(teammateWebhooks.webhook_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((row: { webhook_id: string }) => row.webhook_id);
    });
  }

  /** Token fields always start null: a token is issued only through {@link setTokenHash}. */
  async create(data: Partial<TeammateWebhook>): Promise<TeammateWebhook> {
    if (!data.branch_id) throw new RepositoryError('Teammate webhook must have a branch_id');
    if (!data.created_by) throw new RepositoryError('Teammate webhook must have a created_by');
    if (!data.name) throw new RepositoryError('Teammate webhook must have a name');
    if (!data.prompt) throw new RepositoryError('Teammate webhook must have a prompt');
    if (!data.agentic_tool_config) {
      throw new RepositoryError('Teammate webhook must have an agentic_tool_config');
    }
    const now = new Date();
    const values: TeammateWebhookInsert = {
      webhook_id: data.webhook_id ?? generateId(),
      branch_id: data.branch_id,
      name: data.name,
      description: data.description ?? null,
      prompt: data.prompt,
      ...configColumns(data.agentic_tool_config),
      mcp_server_ids: data.mcp_server_ids ?? null,
      enabled: data.enabled ?? true,
      allow_concurrent_runs: data.allow_concurrent_runs ?? false,
      token_hash: null,
      token_hint: null,
      token_issued_at: null,
      created_at: now,
      updated_at: now,
      created_by: data.created_by,
    };
    try {
      const row = await runDatabaseTransaction(
        this.db,
        async (tx) => {
          await lockBranchForAdmission(tx, values.branch_id);
          return insert(tx, teammateWebhooks).values(values).returning().one();
        },
        { sqliteImmediate: true, sqliteBusyRetries: 9 }
      );
      return rowToWebhook(row as TeammateWebhookRow);
    } catch (error) {
      if (error instanceof RepositoryError || error instanceof EntityNotFoundError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new RepositoryError(`Failed to create teammate webhook: ${message}`, error);
    }
  }

  async findById(id: string): Promise<TeammateWebhook | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(teammateWebhooks)
        .where(eq(teammateWebhooks.webhook_id, fullId))
        .one();
      return row ? rowToWebhook(row as TeammateWebhookRow) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      throw error;
    }
  }

  private filterConditions(filter: TeammateWebhookFilter | undefined) {
    const conditions = [];
    if (filter?.branch_id) conditions.push(eq(teammateWebhooks.branch_id, filter.branch_id));
    if (filter?.enabled !== undefined) {
      conditions.push(eq(teammateWebhooks.enabled, filter.enabled));
    }
    if (filter?.created_by) conditions.push(eq(teammateWebhooks.created_by, filter.created_by));
    return conditions;
  }

  /** Newest first. */
  async findAll(filter?: TeammateWebhookFilter): Promise<TeammateWebhook[]> {
    const conditions = this.filterConditions(filter);
    const rows = await select(this.db)
      .from(teammateWebhooks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(teammateWebhooks.created_at))
      .all();
    return rows.map((row: TeammateWebhookRow) => rowToWebhook(row));
  }

  /** Webhooks whose branch the user may view, via the normalized branch-access predicate. */
  async findAccessible(userId: UUID, filter?: TeammateWebhookFilter): Promise<TeammateWebhook[]> {
    const rows = await select(this.db)
      .from(teammateWebhooks)
      .innerJoin(branches, eq(teammateWebhooks.branch_id, branches.branch_id))
      .where(and(visibleBranchAccessCondition(this.db, userId), ...this.filterConditions(filter)))
      .orderBy(desc(teammateWebhooks.created_at))
      .all();
    const seen = new Set<string>();
    const out: TeammateWebhook[] = [];
    for (const row of rows as Array<{ teammate_webhooks: TeammateWebhookRow }>) {
      if (seen.has(row.teammate_webhooks.webhook_id)) continue;
      seen.add(row.teammate_webhooks.webhook_id);
      out.push(rowToWebhook(row.teammate_webhooks));
    }
    return out;
  }

  /**
   * Row-locked patch. Disabling a webhook fails its queued deliveries with
   * `webhook_disabled` in the same transaction: disable means stop.
   */
  async update(id: string, patch: TeammateWebhookUpdate): Promise<TeammateWebhook> {
    const fullId = await this.resolveId(id);
    const row = await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(
          tx,
          this.db,
          teammateWebhooks,
          eq(teammateWebhooks.webhook_id, fullId)
        );
        const current = await select(tx)
          .from(teammateWebhooks)
          .where(eq(teammateWebhooks.webhook_id, fullId))
          .one();
        if (!current) throw new EntityNotFoundError('TeammateWebhook', id);
        const now = new Date();
        const updated = await update(tx, teammateWebhooks)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...('description' in patch ? { description: patch.description ?? null } : {}),
            ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
            ...(patch.agentic_tool_config !== undefined
              ? configColumns(patch.agentic_tool_config)
              : {}),
            ...('mcp_server_ids' in patch ? { mcp_server_ids: patch.mcp_server_ids ?? null } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.allow_concurrent_runs !== undefined
              ? { allow_concurrent_runs: patch.allow_concurrent_runs }
              : {}),
            updated_at: now,
          })
          .where(eq(teammateWebhooks.webhook_id, fullId))
          .returning()
          .one();
        if (current.enabled && patch.enabled === false) {
          await update(tx, teammateWebhookDeliveries)
            .set({
              status: 'failed',
              failure_code: 'webhook_disabled',
              failed_at: now,
              payload_encrypted: null,
              defer_reason: null,
            })
            .where(
              and(
                eq(teammateWebhookDeliveries.webhook_id, fullId),
                eq(teammateWebhookDeliveries.status, 'queued')
              )
            )
            .run();
        }
        return updated as TeammateWebhookRow;
      },
      { sqliteImmediate: true }
    );
    return rowToWebhook(row);
  }

  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);
    const result = await deleteFrom(this.db, teammateWebhooks)
      .where(eq(teammateWebhooks.webhook_id, fullId))
      .run();
    if (result.rowsAffected === 0) throw new EntityNotFoundError('TeammateWebhook', id);
  }

  /**
   * Replace the token hash atomically; the previous token stops working at
   * commit. The plaintext never reaches this layer.
   */
  async setTokenHash(
    webhookId: TeammateWebhookID,
    tokenHash: string,
    tokenHint: string
  ): Promise<TeammateWebhook> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      throw new RepositoryError('Teammate webhook token hash must be a sha256 hex digest');
    }
    const row = await runDatabaseTransaction(
      this.db,
      async (tx) => {
        const where = eq(teammateWebhooks.webhook_id, webhookId);
        await lockRowForUpdate(tx, this.db, teammateWebhooks, where);
        const now = await getDatabaseNow(tx, teammateWebhooks, where);
        if (!now) throw new EntityNotFoundError('TeammateWebhook', webhookId);
        return update(tx, teammateWebhooks)
          .set({
            token_hash: tokenHash,
            token_hint: tokenHint,
            token_issued_at: now,
            updated_at: now,
          })
          .where(where)
          .returning()
          .one();
      },
      { sqliteImmediate: true }
    );
    return rowToWebhook(row as TeammateWebhookRow);
  }

  /** Ingress only: exact id (no short-id prefix matching) to its verification material. */
  async findIngressCredential(
    webhookId: TeammateWebhookID
  ): Promise<TeammateWebhookIngressCredential | null> {
    const row = await select(this.db, {
      webhook_id: teammateWebhooks.webhook_id,
      branch_id: teammateWebhooks.branch_id,
      enabled: teammateWebhooks.enabled,
      token_hash: teammateWebhooks.token_hash,
    })
      .from(teammateWebhooks)
      .where(eq(teammateWebhooks.webhook_id, webhookId))
      .one();
    if (!row) return null;
    return {
      webhook_id: row.webhook_id as TeammateWebhookID,
      branch_id: row.branch_id as BranchID,
      enabled: Boolean(row.enabled),
      token_hash: row.token_hash ?? null,
    };
  }

  /**
   * Ingress tenant discovery. Run under the `teammate_webhook_ingress_discovery`
   * system capability, which RLS limits to enabled rows; returns the tenant id
   * only. SQLite deployments are single-tenant.
   */
  async findIngressTenantId(db: Database, webhookId: TeammateWebhookID): Promise<string | null> {
    if (isSQLiteDatabase(db)) {
      const row = await select(db, { webhook_id: teammateWebhooks.webhook_id })
        .from(teammateWebhooks)
        .where(and(eq(teammateWebhooks.webhook_id, webhookId), eq(teammateWebhooks.enabled, true)))
        .one();
      return row ? 'default' : null;
    }
    const tenantColumn = (
      teammateWebhooks as unknown as { tenant_id: typeof teammateWebhooks.webhook_id }
    ).tenant_id;
    const row = (await select(db, { tenant_id: tenantColumn })
      .from(teammateWebhooks)
      .where(and(eq(teammateWebhooks.webhook_id, webhookId), eq(teammateWebhooks.enabled, true)))
      .one()) as { tenant_id?: unknown } | null;
    return typeof row?.tenant_id === 'string' && row.tenant_id ? row.tenant_id : null;
  }
}
