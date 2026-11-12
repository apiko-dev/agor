/**
 * Durable teammate webhook deliveries. This repository is the only writer of
 * delivery state; every transition after a claim is fenced on the claim's
 * processing token, so a replica that lost its lease cannot write.
 */

import {
  type BranchID,
  EXECUTING_SESSION_STATUSES,
  isTeammateWebhookFailureCode,
  NONTERMINAL_TASK_STATUSES,
  type PaginatedResult,
  type SessionID,
  type TaskID,
  TEAMMATE_WEBHOOK_LIMITS,
  type TeammateWebhookDeferReason,
  type TeammateWebhookDelivery,
  type TeammateWebhookDeliveryID,
  type TeammateWebhookFailureCode,
  type TeammateWebhookID,
} from '@agor/core/types';
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  databaseNowExpression,
  deleteFrom,
  getDatabaseNow,
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import {
  sessions,
  type TeammateWebhookDeliveryRow,
  tasks,
  teammateWebhookDeliveries,
  teammateWebhooks,
} from '../schema';
import { RepositoryError } from './base';

export type TeammateWebhookAdmitResult =
  | { outcome: 'admitted' | 'duplicate'; delivery: TeammateWebhookDelivery }
  | { outcome: 'rejected'; reason: 'webhook_unavailable' | 'queue_full' };

/** Authority for one claimed delivery. Every later write is fenced on `processing_token`. */
export interface TeammateWebhookDeliveryClaim {
  delivery_id: TeammateWebhookDeliveryID;
  webhook_id: TeammateWebhookID;
  branch_id: BranchID;
  processing_token: string;
  attempt_count: number;
  session_id: SessionID | null;
  received_at: string;
}

export type TeammateWebhookClaimResult =
  | { kind: 'claimed'; claim: TeammateWebhookDeliveryClaim }
  /** The lane is blocked: an active run, a live lease, or a head waiting for its retry time. */
  | { kind: 'busy' }
  | { kind: 'empty' };

export interface TeammateWebhookDueRef {
  tenant_id: string;
  webhook_id: TeammateWebhookID;
}

/** The stored payload is missing or cannot be decrypted. Maps to `payload_unreadable`. */
export class TeammateWebhookPayloadUnreadableError extends RepositoryError {
  constructor(cause?: unknown) {
    super('Teammate webhook payload is unreadable', cause);
    this.name = 'TeammateWebhookPayloadUnreadableError';
  }
}

const NON_TERMINAL = ['queued', 'processing'] as const;
const MAX_LEASE_MS = 60 * 60_000;
const MAX_DELAY_MS = 24 * 60 * 60_000;
const PURGE_BATCH = 500;

function iso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

function rowToDelivery(row: TeammateWebhookDeliveryRow): TeammateWebhookDelivery {
  const base = {
    delivery_id: row.delivery_id as TeammateWebhookDeliveryID,
    webhook_id: row.webhook_id as TeammateWebhookID,
    branch_id: row.branch_id as BranchID,
    received_at: iso(row.received_at),
    idempotency_key: row.idempotency_key ?? null,
    payload_bytes: row.payload_bytes,
    attempt_count: row.attempt_count,
    next_attempt_at: iso(row.next_attempt_at),
    session_id: (row.session_id as SessionID | null) ?? null,
  };
  switch (row.status) {
    case 'queued':
      return {
        ...base,
        status: 'queued',
        defer_reason: (row.defer_reason as TeammateWebhookDeferReason | null) ?? null,
      };
    case 'processing':
      return { ...base, status: 'processing' };
    case 'started':
      return {
        ...base,
        status: 'started',
        task_id: (row.task_id as TaskID | null) ?? null,
        started_at: iso(row.started_at ?? row.received_at),
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        failure_code: isTeammateWebhookFailureCode(row.failure_code)
          ? row.failure_code
          : 'retries_exhausted',
        failed_at: iso(row.failed_at ?? row.received_at),
      };
  }
}

function rowToClaim(row: TeammateWebhookDeliveryRow): TeammateWebhookDeliveryClaim {
  if (!row.processing_token) throw new RepositoryError('Claimed delivery has no processing token');
  return {
    delivery_id: row.delivery_id as TeammateWebhookDeliveryID,
    webhook_id: row.webhook_id as TeammateWebhookID,
    branch_id: row.branch_id as BranchID,
    processing_token: row.processing_token,
    attempt_count: row.attempt_count,
    session_id: (row.session_id as SessionID | null) ?? null,
    received_at: iso(row.received_at),
  };
}

function assertDuration(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RepositoryError(`${label} must be an integer between 0 and ${max} ms`);
  }
}

const TERMINAL_PAYLOAD_RESET = {
  payload_encrypted: null,
  processing_token: null,
  processing_expires_at: null,
  defer_reason: null,
} as const;

export class TeammateWebhookDeliveryRepository {
  constructor(private db: Database) {}

  private lane(webhookId: TeammateWebhookID) {
    return and(
      eq(teammateWebhookDeliveries.webhook_id, webhookId),
      inArray(teammateWebhookDeliveries.status, [...NON_TERMINAL])
    );
  }

  /**
   * Durably admit one authenticated call. One transaction under the webhook
   * row lock re-checks `enabled`, returns the existing row for a repeated
   * idempotency key, and bounds the queue.
   */
  async admit(input: {
    webhookId: TeammateWebhookID;
    idempotencyKey: string | null;
    payload: unknown;
    payloadBytes: number;
    /** Deterministic SQLite test clock; PostgreSQL always uses database time. */
    now?: Date;
  }): Promise<TeammateWebhookAdmitResult> {
    const key = input.idempotencyKey?.trim() || null;
    if (key && key.length > TEAMMATE_WEBHOOK_LIMITS.maxIdempotencyKeyChars) {
      throw new RepositoryError('Teammate webhook idempotency key is too long');
    }
    if (!Number.isSafeInteger(input.payloadBytes) || input.payloadBytes < 0) {
      throw new RepositoryError('Teammate webhook payload size is invalid');
    }
    const serialized = JSON.stringify(input.payload ?? null);
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        const webhookWhere = eq(teammateWebhooks.webhook_id, input.webhookId);
        await lockRowForUpdate(tx, this.db, teammateWebhooks, webhookWhere);
        const webhook = await select(tx, {
          enabled: teammateWebhooks.enabled,
          branch_id: teammateWebhooks.branch_id,
        })
          .from(teammateWebhooks)
          .where(webhookWhere)
          .one();
        if (!webhook?.enabled) return { outcome: 'rejected', reason: 'webhook_unavailable' };

        const byKey = key
          ? and(
              eq(teammateWebhookDeliveries.webhook_id, input.webhookId),
              eq(teammateWebhookDeliveries.idempotency_key, key)
            )
          : undefined;
        if (byKey) {
          const existing = await select(tx).from(teammateWebhookDeliveries).where(byKey).one();
          if (existing) {
            return {
              outcome: 'duplicate',
              delivery: rowToDelivery(existing as TeammateWebhookDeliveryRow),
            };
          }
        }

        const queued = await select(tx, { count: sql<number>`count(*)` })
          .from(teammateWebhookDeliveries)
          .where(this.lane(input.webhookId))
          .one();
        if (Number(queued?.count ?? 0) >= TEAMMATE_WEBHOOK_LIMITS.maxQueuedPerWebhook) {
          return { outcome: 'rejected', reason: 'queue_full' };
        }

        const now = await getDatabaseNow(tx, teammateWebhooks, webhookWhere, input.now);
        if (!now) throw new RepositoryError('Unable to obtain database time for webhook admission');
        const deliveryId = generateId() as TeammateWebhookDeliveryID;
        await insert(tx, teammateWebhookDeliveries)
          .values({
            delivery_id: deliveryId,
            webhook_id: input.webhookId,
            branch_id: webhook.branch_id,
            status: 'queued',
            idempotency_key: key,
            payload_encrypted: encryptApiKey(serialized),
            payload_bytes: input.payloadBytes,
            payload_expires_at: new Date(now.getTime() + TEAMMATE_WEBHOOK_LIMITS.payloadTtlMs),
            attempt_count: 0,
            next_attempt_at: now,
            received_at: now,
          })
          .onConflictDoNothing()
          .run();
        const row = await select(tx)
          .from(teammateWebhookDeliveries)
          .where(byKey ?? eq(teammateWebhookDeliveries.delivery_id, deliveryId))
          .one();
        if (!row) throw new RepositoryError('Failed to retrieve admitted webhook delivery');
        return {
          outcome: row.delivery_id === deliveryId ? 'admitted' : 'duplicate',
          delivery: rowToDelivery(row as TeammateWebhookDeliveryRow),
        };
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Fleet discovery under the `teammate_webhook_delivery_discovery` system
   * capability. Webhooks with a due non-terminal delivery; routing ids only.
   */
  async findDueWebhookRefs(
    db: Database,
    options: { limit?: number; now?: Date } = {}
  ): Promise<TeammateWebhookDueRef[]> {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RepositoryError('Webhook delivery discovery limit must be between 1 and 1000');
    }
    const now = databaseNowExpression(db, options.now);
    const tenantColumn = isSQLiteDatabase(db)
      ? sql<string>`'default'`
      : sql<string>`${(teammateWebhookDeliveries as unknown as { tenant_id: unknown }).tenant_id}`;
    const rows = await select(db, {
      tenant_id: tenantColumn,
      webhook_id: teammateWebhookDeliveries.webhook_id,
      due_at: sql`min(${teammateWebhookDeliveries.next_attempt_at})`,
    })
      .from(teammateWebhookDeliveries)
      .where(
        and(
          inArray(teammateWebhookDeliveries.status, [...NON_TERMINAL]),
          lte(teammateWebhookDeliveries.next_attempt_at, now),
          or(
            eq(teammateWebhookDeliveries.status, 'queued'),
            lte(teammateWebhookDeliveries.processing_expires_at, now)
          )
        )
      )
      .groupBy(tenantColumn, teammateWebhookDeliveries.webhook_id)
      .orderBy(
        sql`min(${teammateWebhookDeliveries.next_attempt_at})`,
        teammateWebhookDeliveries.webhook_id
      )
      .limit(limit)
      .all();
    return (rows as Array<{ tenant_id: unknown; webhook_id: string }>).map((row) => ({
      tenant_id: String(row.tenant_id),
      webhook_id: row.webhook_id as TeammateWebhookID,
    }));
  }

  /**
   * Claim the next delivery of one webhook under the webhook row lock.
   *
   * Without concurrent runs the lane is strict FIFO: only the oldest
   * non-terminal delivery may run, and only while no earlier run of this
   * webhook is active. A blocked lane pushes every waiting delivery's
   * `next_attempt_at` forward so discovery stays quiet until it can move.
   * Busy waiting never counts as an attempt. Expired processing leases are
   * reclaimable (crash recovery); expired payloads fail as `payload_expired`.
   */
  async claimNext(
    webhookId: TeammateWebhookID,
    options: { leaseMs: number; busyDelayMs: number; now?: Date }
  ): Promise<TeammateWebhookClaimResult> {
    assertDuration(options.leaseMs, MAX_LEASE_MS, 'Webhook delivery lease');
    assertDuration(options.busyDelayMs, MAX_DELAY_MS, 'Webhook busy delay');
    if (options.leaseMs < 1) throw new RepositoryError('Webhook delivery lease must be positive');
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        const webhookWhere = eq(teammateWebhooks.webhook_id, webhookId);
        await lockRowForUpdate(tx, this.db, teammateWebhooks, webhookWhere);
        const webhook = await select(tx, {
          enabled: teammateWebhooks.enabled,
          allow_concurrent_runs: teammateWebhooks.allow_concurrent_runs,
        })
          .from(teammateWebhooks)
          .where(webhookWhere)
          .one();
        if (!webhook) return { kind: 'empty' };
        const now = await getDatabaseNow(tx, teammateWebhooks, webhookWhere, options.now);
        if (!now) throw new RepositoryError('Unable to obtain database time for webhook claim');

        const reclaimable = or(
          eq(teammateWebhookDeliveries.status, 'queued'),
          lte(teammateWebhookDeliveries.processing_expires_at, now)
        );
        if (!webhook.enabled) {
          await this.failWhere(tx, and(this.lane(webhookId), reclaimable), 'webhook_disabled', now);
          return { kind: 'empty' };
        }
        await this.failWhere(
          tx,
          and(
            this.lane(webhookId),
            reclaimable,
            lte(teammateWebhookDeliveries.payload_expires_at, now)
          ),
          'payload_expired',
          now
        );

        const candidates = select(tx)
          .from(teammateWebhookDeliveries)
          .orderBy(
            asc(teammateWebhookDeliveries.received_at),
            asc(teammateWebhookDeliveries.delivery_id)
          )
          .limit(1);
        let head: TeammateWebhookDeliveryRow | null;
        if (webhook.allow_concurrent_runs) {
          head = (await candidates
            .where(
              and(
                this.lane(webhookId),
                reclaimable,
                lte(teammateWebhookDeliveries.next_attempt_at, now)
              )
            )
            .one()) as TeammateWebhookDeliveryRow | null;
          if (!head) return { kind: 'empty' };
        } else {
          head = (await candidates
            .where(this.lane(webhookId))
            .one()) as TeammateWebhookDeliveryRow | null;
          if (!head) return { kind: 'empty' };
          const leaseLive =
            head.status === 'processing' &&
            head.processing_expires_at !== null &&
            new Date(head.processing_expires_at) > now;
          const notDue = new Date(head.next_attempt_at) > now;
          const active = !leaseLive && !notDue && (await this.hasActiveRun(tx, webhookId, now));
          if (leaseLive || notDue || active) {
            const blockedUntil = notDue
              ? new Date(head.next_attempt_at)
              : new Date(now.getTime() + options.busyDelayMs);
            if (active) {
              await update(tx, teammateWebhookDeliveries)
                .set({ next_attempt_at: blockedUntil, defer_reason: 'busy' })
                .where(eq(teammateWebhookDeliveries.delivery_id, head.delivery_id))
                .run();
            }
            await update(tx, teammateWebhookDeliveries)
              .set({ next_attempt_at: blockedUntil, defer_reason: 'busy' })
              .where(
                and(
                  eq(teammateWebhookDeliveries.webhook_id, webhookId),
                  eq(teammateWebhookDeliveries.status, 'queued'),
                  ne(teammateWebhookDeliveries.delivery_id, head.delivery_id),
                  lt(teammateWebhookDeliveries.next_attempt_at, blockedUntil)
                )
              )
              .run();
            return { kind: 'busy' };
          }
        }

        const claimed = await update(tx, teammateWebhookDeliveries)
          .set({
            status: 'processing',
            processing_token: generateId(),
            processing_expires_at: new Date(now.getTime() + options.leaseMs),
            defer_reason: null,
          })
          .where(eq(teammateWebhookDeliveries.delivery_id, head.delivery_id))
          .returning()
          .one();
        return { kind: 'claimed', claim: rowToClaim(claimed as TeammateWebhookDeliveryRow) };
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Another live claim of this webhook (left over from concurrent mode), or a
   * started run whose Session is executing or has a non-terminal Task.
   */
  private async hasActiveRun(
    tx: Database,
    webhookId: TeammateWebhookID,
    now: Date
  ): Promise<boolean> {
    const liveClaim = await select(tx, { one: sql<number>`1` })
      .from(teammateWebhookDeliveries)
      .where(
        and(
          eq(teammateWebhookDeliveries.webhook_id, webhookId),
          eq(teammateWebhookDeliveries.status, 'processing'),
          gt(teammateWebhookDeliveries.processing_expires_at, now)
        )
      )
      .limit(1)
      .one();
    if (liveClaim) return true;
    const row = await select(tx, { one: sql<number>`1` })
      .from(teammateWebhookDeliveries)
      .innerJoin(sessions, eq(sessions.session_id, teammateWebhookDeliveries.session_id))
      .where(
        and(
          eq(teammateWebhookDeliveries.webhook_id, webhookId),
          eq(teammateWebhookDeliveries.status, 'started'),
          or(
            inArray(sessions.status, [...EXECUTING_SESSION_STATUSES]),
            sql`EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.session_id} = ${sessions.session_id} AND ${inArray(tasks.status, [...NONTERMINAL_TASK_STATUSES])})`
          )
        )
      )
      .limit(1)
      .one();
    return row != null;
  }

  private async failWhere(
    tx: Database,
    where: ReturnType<typeof and>,
    code: TeammateWebhookFailureCode,
    now: Date | SQL
  ): Promise<number> {
    const result = await update(tx, teammateWebhookDeliveries)
      .set({ status: 'failed', failure_code: code, failed_at: now, ...TERMINAL_PAYLOAD_RESET })
      .where(where)
      .run();
    return result.rowsAffected;
  }

  /** One fenced transition for a claimed delivery. False when the claim is no longer current. */
  private async fenced(
    claim: TeammateWebhookDeliveryClaim,
    set: (now: Date) => Record<string, unknown>,
    nowOverride?: Date
  ): Promise<boolean> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        const where = and(
          eq(teammateWebhookDeliveries.delivery_id, claim.delivery_id),
          eq(teammateWebhookDeliveries.status, 'processing'),
          eq(teammateWebhookDeliveries.processing_token, claim.processing_token)
        );
        await lockRowForUpdate(tx, this.db, teammateWebhookDeliveries, where!);
        const now = await getDatabaseNow(tx, teammateWebhookDeliveries, where!, nowOverride);
        if (!now) return false;
        const result = await update(tx, teammateWebhookDeliveries).set(set(now)).where(where).run();
        return result.rowsAffected > 0;
      },
      { sqliteImmediate: true }
    );
  }

  /** Decrypt the claimed delivery's payload. Throws {@link TeammateWebhookPayloadUnreadableError}. */
  async decryptPayload(claim: TeammateWebhookDeliveryClaim): Promise<unknown> {
    const row = await select(this.db, { payload: teammateWebhookDeliveries.payload_encrypted })
      .from(teammateWebhookDeliveries)
      .where(
        and(
          eq(teammateWebhookDeliveries.delivery_id, claim.delivery_id),
          eq(teammateWebhookDeliveries.processing_token, claim.processing_token)
        )
      )
      .one();
    if (!row?.payload) throw new TeammateWebhookPayloadUnreadableError();
    try {
      return JSON.parse(decryptApiKey(row.payload)) as unknown;
    } catch (error) {
      throw new TeammateWebhookPayloadUnreadableError(error);
    }
  }

  /** Record the deterministic Session before its first Task. Idempotent. */
  recordSession(claim: TeammateWebhookDeliveryClaim, sessionId: SessionID): Promise<boolean> {
    return this.fenced(claim, () => ({ session_id: sessionId }));
  }

  /** Terminal success. Drops the payload. */
  markStarted(claim: TeammateWebhookDeliveryClaim, taskId: TaskID, now?: Date): Promise<boolean> {
    return this.fenced(
      claim,
      (at) => ({ status: 'started', task_id: taskId, started_at: at, ...TERMINAL_PAYLOAD_RESET }),
      now
    );
  }

  /** Terminal failure. Drops the payload. */
  markFailed(
    claim: TeammateWebhookDeliveryClaim,
    code: TeammateWebhookFailureCode,
    now?: Date
  ): Promise<boolean> {
    return this.fenced(
      claim,
      (at) => ({ status: 'failed', failure_code: code, failed_at: at, ...TERMINAL_PAYLOAD_RESET }),
      now
    );
  }

  /** Back to the queue after a transient error; counts as an attempt. */
  deferRetry(claim: TeammateWebhookDeliveryClaim, delayMs: number, now?: Date): Promise<boolean> {
    assertDuration(delayMs, MAX_DELAY_MS, 'Webhook retry delay');
    return this.fenced(
      claim,
      (at) => ({
        status: 'queued',
        attempt_count: claim.attempt_count + 1,
        next_attempt_at: new Date(at.getTime() + delayMs),
        defer_reason: 'transient_retry',
        processing_token: null,
        processing_expires_at: null,
      }),
      now
    );
  }

  /**
   * Current-tenant maintenance in bounded batches: fail deliveries whose
   * payload outlived its TTL, and delete terminal rows past retention.
   */
  async purge(now?: Date): Promise<{ expired: number; deleted: number }> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        const at = databaseNowExpression(tx, now);
        const expiredIds = await select(tx, { id: teammateWebhookDeliveries.delivery_id })
          .from(teammateWebhookDeliveries)
          .where(
            and(
              inArray(teammateWebhookDeliveries.status, [...NON_TERMINAL]),
              or(
                eq(teammateWebhookDeliveries.status, 'queued'),
                lte(teammateWebhookDeliveries.processing_expires_at, at)
              ),
              lte(teammateWebhookDeliveries.payload_expires_at, at)
            )
          )
          .limit(PURGE_BATCH)
          .all();
        const expired = expiredIds.length
          ? await this.failWhere(
              tx,
              inArray(
                teammateWebhookDeliveries.delivery_id,
                expiredIds.map((row: { id: string }) => row.id)
              ),
              'payload_expired',
              at
            )
          : 0;
        // Retention is coarse, so the application clock is precise enough here.
        const cutoff = new Date(
          (now ?? new Date()).getTime() - TEAMMATE_WEBHOOK_LIMITS.terminalRetentionMs
        );
        const staleIds = await select(tx, { id: teammateWebhookDeliveries.delivery_id })
          .from(teammateWebhookDeliveries)
          .where(
            and(
              inArray(teammateWebhookDeliveries.status, ['started', 'failed']),
              lt(teammateWebhookDeliveries.received_at, cutoff)
            )
          )
          .orderBy(teammateWebhookDeliveries.received_at, teammateWebhookDeliveries.delivery_id)
          .limit(PURGE_BATCH)
          .all();
        const deleted = staleIds.length
          ? (
              await deleteFrom(tx, teammateWebhookDeliveries)
                .where(
                  inArray(
                    teammateWebhookDeliveries.delivery_id,
                    staleIds.map((row: { id: string }) => row.id)
                  )
                )
                .run()
            ).rowsAffected
          : 0;
        return { expired, deleted };
      },
      { sqliteImmediate: true }
    );
  }

  async findById(deliveryId: TeammateWebhookDeliveryID): Promise<TeammateWebhookDelivery | null> {
    const row = await select(this.db)
      .from(teammateWebhookDeliveries)
      .where(eq(teammateWebhookDeliveries.delivery_id, deliveryId))
      .one();
    return row ? rowToDelivery(row as TeammateWebhookDeliveryRow) : null;
  }

  /** Newest first, without payloads. */
  async findByWebhook(
    webhookId: TeammateWebhookID,
    page: { limit?: number; skip?: number } = {}
  ): Promise<PaginatedResult<TeammateWebhookDelivery>> {
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
    const skip = Math.max(page.skip ?? 0, 0);
    const where = eq(teammateWebhookDeliveries.webhook_id, webhookId);
    const [total, rows] = await Promise.all([
      select(this.db, { count: sql<number>`count(*)` })
        .from(teammateWebhookDeliveries)
        .where(where)
        .one(),
      select(this.db)
        .from(teammateWebhookDeliveries)
        .where(where)
        .orderBy(
          desc(teammateWebhookDeliveries.received_at),
          desc(teammateWebhookDeliveries.delivery_id)
        )
        .limit(limit)
        .offset(skip)
        .all(),
    ]);
    return {
      total: Number(total?.count ?? 0),
      limit,
      skip,
      data: rows.map((row: TeammateWebhookDeliveryRow) => rowToDelivery(row)),
    };
  }
}
