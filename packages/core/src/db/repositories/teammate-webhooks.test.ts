import type { BranchID, SessionID, TeammateWebhookID, UserID, UUID } from '@agor/core/types';
import { TEAMMATE_WEBHOOK_LIMITS } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId, shortId } from '../../lib/ids';
import type { Database } from '../client';
import { select, update } from '../database-wrapper';
import { teammateWebhookDeliveries, teammateWebhooks } from '../schema';
import { dbTest } from '../test-helpers';
import { AgenticToolPresetRepository } from './agentic-tool-presets';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import {
  type TeammateWebhookDeliveryClaim,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookPayloadUnreadableError,
} from './teammate-webhook-deliveries';
import { TeammateWebhookRepository } from './teammate-webhooks';
import { UsersRepository } from './users';

const HASH = 'a'.repeat(64);
const LEASE = { leaseMs: 60_000, busyDelayMs: 15_000 };

async function seed(db: Database, options: { allowConcurrent?: boolean } = {}) {
  const user = await new UsersRepository(db).create({
    email: `webhook-${generateId()}@example.com`,
    name: 'Webhook Test',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `webhook-test-${generateId()}`,
    name: 'webhook-test',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'teammate',
    ref: 'refs/heads/teammate',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    new_branch: false,
    last_used: new Date().toISOString(),
    created_by: user.user_id,
    others_can: 'none',
  });
  const webhooks = new TeammateWebhookRepository(db);
  const webhook = await webhooks.create({
    branch_id: branch.branch_id as BranchID,
    created_by: user.user_id as UUID,
    name: 'Jira triage',
    prompt: 'Triage {{payload.issue.key}}',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    allow_concurrent_runs: options.allowConcurrent ?? false,
  });
  return {
    userId: user.user_id as UUID,
    branchId: branch.branch_id as BranchID,
    webhook,
    webhooks,
    deliveries: new TeammateWebhookDeliveryRepository(db),
  };
}

async function admit(
  deliveries: TeammateWebhookDeliveryRepository,
  webhookId: TeammateWebhookID,
  options: { key?: string | null; payload?: unknown; now?: Date } = {}
) {
  return deliveries.admit({
    webhookId,
    idempotencyKey: options.key ?? null,
    payload: options.payload ?? { issue: { key: 'P-1' } },
    payloadBytes: 32,
    now: options.now,
  });
}

async function claim(
  deliveries: TeammateWebhookDeliveryRepository,
  webhookId: TeammateWebhookID,
  now?: Date
): Promise<TeammateWebhookDeliveryClaim> {
  const result = await deliveries.claimNext(webhookId, { ...LEASE, now });
  if (result.kind !== 'claimed') throw new Error(`expected a claim, got ${result.kind}`);
  return result.claim;
}

async function rawDelivery(db: Database, deliveryId: string) {
  return select(db)
    .from(teammateWebhookDeliveries)
    .where(eq(teammateWebhookDeliveries.delivery_id, deliveryId))
    .one();
}

describe('TeammateWebhookRepository', () => {
  dbTest('never projects the token hash, and setTokenHash replaces it', async ({ db }) => {
    const { webhook, webhooks } = await seed(db);
    expect(webhook).not.toHaveProperty('token_hash');
    expect(webhook.token_hint).toBeNull();
    expect(await webhooks.findIngressCredential(webhook.webhook_id)).toMatchObject({
      enabled: true,
      token_hash: null,
    });

    const issued = await webhooks.setTokenHash(webhook.webhook_id, HASH, 'agwh_abcd');
    expect(issued.token_hint).toBe('agwh_abcd');
    expect(issued.token_issued_at).not.toBeNull();
    expect(JSON.stringify(issued)).not.toContain(HASH);
    expect(JSON.stringify(await webhooks.findAll())).not.toContain(HASH);

    const rotated = 'b'.repeat(64);
    await webhooks.setTokenHash(webhook.webhook_id, rotated, 'agwh_efgh');
    expect((await webhooks.findIngressCredential(webhook.webhook_id))?.token_hash).toBe(rotated);
    await expect(webhooks.setTokenHash(webhook.webhook_id, 'plaintext', 'x')).rejects.toThrow(
      /sha256/
    );
  });

  dbTest('ingress lookups require the exact id, never a short-id prefix', async ({ db }) => {
    const { webhook, webhooks } = await seed(db);
    const prefix = shortId(webhook.webhook_id) as TeammateWebhookID;
    expect(await webhooks.findIngressCredential(prefix)).toBeNull();
    expect(await webhooks.findIngressTenantId(db, prefix)).toBeNull();
    expect(await webhooks.findIngressTenantId(db, webhook.webhook_id)).toBe('default');
    await webhooks.update(webhook.webhook_id, { enabled: false });
    expect(await webhooks.findIngressTenantId(db, webhook.webhook_id)).toBeNull();
  });

  dbTest('stores a preset as its restrictive FK column', async ({ db }) => {
    const { webhook, webhooks, userId } = await seed(db);
    const preset = await new AgenticToolPresetRepository(db).create(
      {
        tool: 'codex',
        name: 'Webhook preset',
        configuration: { modelConfig: { mode: 'exact', model: 'gpt-5.4' } },
      },
      userId as UserID
    );
    const updated = await webhooks.update(webhook.webhook_id, {
      agentic_tool_config: { agentic_tool: 'codex', preset_id: preset.preset_id },
    });
    expect(updated.agentic_tool_config.preset_id).toBe(preset.preset_id);
    const row = await select(db)
      .from(teammateWebhooks)
      .where(eq(teammateWebhooks.webhook_id, webhook.webhook_id))
      .one();
    expect(row?.agentic_tool_preset_id).toBe(preset.preset_id);
    expect(JSON.stringify(row?.agentic_tool_config)).not.toContain(preset.preset_id);
  });

  dbTest('findAccessible applies branch RBAC', async ({ db }) => {
    const { webhook, webhooks, userId, branchId } = await seed(db);
    const stranger = await new UsersRepository(db).create({
      email: `stranger-${generateId()}@example.com`,
      name: 'Stranger',
    });
    expect(
      (await webhooks.findAccessible(userId, { branch_id: branchId })).map((w) => w.webhook_id)
    ).toEqual([webhook.webhook_id]);
    expect(await webhooks.findAccessible(stranger.user_id as UUID)).toEqual([]);
  });

  dbTest('disabling fails queued deliveries with webhook_disabled', async ({ db }) => {
    const { webhook, webhooks, deliveries } = await seed(db);
    await webhooks.setTokenHash(webhook.webhook_id, HASH, 'agwh_abcd');
    const admitted = await admit(deliveries, webhook.webhook_id);
    if (admitted.outcome === 'rejected') throw new Error('expected admission');
    await webhooks.update(webhook.webhook_id, { enabled: false });
    expect(await deliveries.findById(admitted.delivery.delivery_id)).toMatchObject({
      status: 'failed',
      failure_code: 'webhook_disabled',
    });
    expect((await rawDelivery(db, admitted.delivery.delivery_id))?.payload_encrypted).toBeNull();
  });
});

describe('TeammateWebhookDeliveryRepository', () => {
  dbTest('dedupes on the idempotency key and rejects a disabled webhook', async ({ db }) => {
    const { webhook, webhooks, deliveries } = await seed(db);
    const first = await admit(deliveries, webhook.webhook_id, { key: 'jira-1' });
    const second = await admit(deliveries, webhook.webhook_id, { key: 'jira-1' });
    expect(first.outcome).toBe('admitted');
    expect(second.outcome).toBe('duplicate');
    if (first.outcome === 'rejected' || second.outcome === 'rejected') throw new Error('rejected');
    expect(second.delivery.delivery_id).toBe(first.delivery.delivery_id);
    expect(first.delivery).not.toHaveProperty('payload_encrypted');

    await webhooks.update(webhook.webhook_id, { enabled: false });
    expect(await admit(deliveries, webhook.webhook_id)).toEqual({
      outcome: 'rejected',
      reason: 'webhook_unavailable',
    });
  });

  dbTest('rejects with queue_full past the per-webhook bound', async ({ db }) => {
    const { webhook, deliveries } = await seed(db);
    for (let index = 0; index < TEAMMATE_WEBHOOK_LIMITS.maxQueuedPerWebhook; index++) {
      expect((await admit(deliveries, webhook.webhook_id)).outcome).toBe('admitted');
    }
    expect(await admit(deliveries, webhook.webhook_id)).toEqual({
      outcome: 'rejected',
      reason: 'queue_full',
    });
  });

  dbTest('runs a happy path with fenced transitions and drops the payload', async ({ db }) => {
    const { webhook, deliveries, userId, branchId } = await seed(db);
    const admitted = await admit(deliveries, webhook.webhook_id, { payload: { a: [1, 'x'] } });
    if (admitted.outcome === 'rejected') throw new Error('rejected');
    const current = await claim(deliveries, webhook.webhook_id);
    expect(await deliveries.decryptPayload(current)).toEqual({ a: [1, 'x'] });

    const session = await new SessionRepository(db).create({
      branch_id: branchId,
      created_by: userId,
      agentic_tool: 'claude-code',
    });
    const task = await new TaskRepository(db).create({
      session_id: session.session_id,
      created_by: userId,
      status: 'completed',
    });
    expect(await deliveries.recordSession(current, session.session_id)).toBe(true);
    const stale = { ...current, processing_token: generateId() };
    expect(await deliveries.markStarted(stale, task.task_id)).toBe(false);
    expect(await deliveries.markStarted(current, task.task_id)).toBe(true);
    expect(await deliveries.markStarted(current, task.task_id)).toBe(false);

    expect(await deliveries.findById(current.delivery_id)).toMatchObject({
      status: 'started',
      session_id: session.session_id,
      task_id: task.task_id,
    });
    expect((await rawDelivery(db, current.delivery_id))?.payload_encrypted).toBeNull();
    await expect(deliveries.decryptPayload(current)).rejects.toBeInstanceOf(
      TeammateWebhookPayloadUnreadableError
    );
  });

  dbTest(
    'keeps strict FIFO and defers while a run is active without counting attempts',
    async ({ db }) => {
      const { webhook, deliveries, userId, branchId } = await seed(db);
      const t0 = new Date('2026-11-12T10:00:00.000Z');
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const admitted = await admit(deliveries, webhook.webhook_id, {
          now: new Date(t0.getTime() + index),
        });
        if (admitted.outcome === 'rejected') throw new Error('rejected');
        ids.push(admitted.delivery.delivery_id);
      }

      const first = await claim(deliveries, webhook.webhook_id, new Date(t0.getTime() + 10));
      expect(first.delivery_id).toBe(ids[0]);
      expect(
        (
          await deliveries.claimNext(webhook.webhook_id, {
            ...LEASE,
            now: new Date(t0.getTime() + 20),
          })
        ).kind
      ).toBe('busy');

      const session = await new SessionRepository(db).create({
        branch_id: branchId,
        created_by: userId,
        agentic_tool: 'claude-code',
      });
      const task = await new TaskRepository(db).create({
        session_id: session.session_id,
        created_by: userId,
        status: 'running',
      });
      await deliveries.recordSession(first, session.session_id);
      await deliveries.markStarted(first, task.task_id);

      const busyAt = new Date(t0.getTime() + 30);
      expect((await deliveries.claimNext(webhook.webhook_id, { ...LEASE, now: busyAt })).kind).toBe(
        'busy'
      );
      const blockedUntil = new Date(t0.getTime() + 20 + LEASE.busyDelayMs);
      for (const id of ids.slice(1)) {
        expect(await deliveries.findById(id as never)).toMatchObject({
          status: 'queued',
          defer_reason: 'busy',
          attempt_count: 0,
          next_attempt_at: blockedUntil.toISOString(),
        });
      }
      // Discovery stays quiet while the lane is blocked.
      expect(
        await deliveries.findDueWebhookRefs(db, { now: new Date(busyAt.getTime() + 1) })
      ).toEqual([]);

      await new TaskRepository(db).update(task.task_id, { status: 'completed' });
      const later = blockedUntil;
      expect(await deliveries.findDueWebhookRefs(db, { now: later })).toEqual([
        { tenant_id: 'default', webhook_id: webhook.webhook_id },
      ]);
      expect((await claim(deliveries, webhook.webhook_id, later)).delivery_id).toBe(ids[1]);
    }
  );

  dbTest('claims in parallel when concurrent runs are allowed', async ({ db }) => {
    const { webhook, deliveries } = await seed(db, { allowConcurrent: true });
    await admit(deliveries, webhook.webhook_id);
    await admit(deliveries, webhook.webhook_id);
    const a = await claim(deliveries, webhook.webhook_id);
    const b = await claim(deliveries, webhook.webhook_id);
    expect(a.delivery_id).not.toBe(b.delivery_id);
    expect((await deliveries.claimNext(webhook.webhook_id, LEASE)).kind).toBe('empty');
  });

  dbTest('reclaims an expired lease and fences the stale holder', async ({ db }) => {
    const { webhook, deliveries } = await seed(db);
    const t0 = new Date('2026-11-12T10:00:00.000Z');
    await admit(deliveries, webhook.webhook_id, { now: t0 });
    const first = await claim(deliveries, webhook.webhook_id, t0);
    const afterLease = new Date(t0.getTime() + LEASE.leaseMs + 1);
    const second = await claim(deliveries, webhook.webhook_id, afterLease);
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.processing_token).not.toBe(first.processing_token);
    expect(await deliveries.markFailed(first, 'invalid_config')).toBe(false);
    expect(await deliveries.markFailed(second, 'invalid_config')).toBe(true);
  });

  dbTest(
    'a transient retry counts an attempt and blocks the FIFO lane until due',
    async ({ db }) => {
      const { webhook, deliveries } = await seed(db);
      const t0 = new Date('2026-11-12T10:00:00.000Z');
      await admit(deliveries, webhook.webhook_id, { now: t0 });
      await admit(deliveries, webhook.webhook_id, { now: new Date(t0.getTime() + 1) });
      const first = await claim(deliveries, webhook.webhook_id, t0);
      expect(await deliveries.deferRetry(first, 5_000, t0)).toBe(true);
      expect(await deliveries.findById(first.delivery_id)).toMatchObject({
        status: 'queued',
        attempt_count: 1,
        defer_reason: 'transient_retry',
      });
      expect(
        (
          await deliveries.claimNext(webhook.webhook_id, {
            ...LEASE,
            now: new Date(t0.getTime() + 10),
          })
        ).kind
      ).toBe('busy');
      const retried = await claim(deliveries, webhook.webhook_id, new Date(t0.getTime() + 5_000));
      expect(retried).toMatchObject({ delivery_id: first.delivery_id, attempt_count: 1 });
    }
  );

  dbTest('purges expired payloads and terminal rows past retention', async ({ db }) => {
    const { webhook, deliveries } = await seed(db);
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const expiring = await admit(deliveries, webhook.webhook_id, { now: t0 });
    if (expiring.outcome === 'rejected') throw new Error('rejected');
    const afterTtl = new Date(t0.getTime() + TEAMMATE_WEBHOOK_LIMITS.payloadTtlMs + 1);
    expect(await deliveries.purge(afterTtl)).toEqual({ expired: 1, deleted: 0 });
    expect(await deliveries.findById(expiring.delivery.delivery_id)).toMatchObject({
      status: 'failed',
      failure_code: 'payload_expired',
    });
    expect((await rawDelivery(db, expiring.delivery.delivery_id))?.payload_encrypted).toBeNull();

    const afterRetention = new Date(t0.getTime() + TEAMMATE_WEBHOOK_LIMITS.terminalRetentionMs + 1);
    expect(await deliveries.purge(afterRetention)).toEqual({ expired: 0, deleted: 1 });
    expect(await deliveries.findById(expiring.delivery.delivery_id)).toBeNull();
  });

  dbTest('fails an expired head at claim time instead of running it', async ({ db }) => {
    const { webhook, deliveries } = await seed(db);
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const admitted = await admit(deliveries, webhook.webhook_id, { now: t0 });
    if (admitted.outcome === 'rejected') throw new Error('rejected');
    const afterTtl = new Date(t0.getTime() + TEAMMATE_WEBHOOK_LIMITS.payloadTtlMs + 1);
    expect((await deliveries.claimNext(webhook.webhook_id, { ...LEASE, now: afterTtl })).kind).toBe(
      'empty'
    );
    expect(await deliveries.findById(admitted.delivery.delivery_id)).toMatchObject({
      failure_code: 'payload_expired',
    });
  });

  dbTest('reports unreadable ciphertext as a typed error', async ({ db }) => {
    const { webhook, deliveries } = await seed(db);
    await admit(deliveries, webhook.webhook_id);
    const current = await claim(deliveries, webhook.webhook_id);
    await update(db, teammateWebhookDeliveries)
      .set({ payload_encrypted: 'not-ciphertext' })
      .where(eq(teammateWebhookDeliveries.delivery_id, current.delivery_id))
      .run();
    await expect(deliveries.decryptPayload(current)).rejects.toBeInstanceOf(
      TeammateWebhookPayloadUnreadableError
    );
  });

  dbTest('lists history newest first without payloads', async ({ db }) => {
    const { webhook, deliveries } = await seed(db);
    const t0 = new Date('2026-11-12T10:00:00.000Z');
    await admit(deliveries, webhook.webhook_id, { now: t0 });
    await admit(deliveries, webhook.webhook_id, { now: new Date(t0.getTime() + 1) });
    const page = await deliveries.findByWebhook(webhook.webhook_id, { limit: 1 });
    expect(page.total).toBe(2);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.received_at).toBe(new Date(t0.getTime() + 1).toISOString());
    expect(JSON.stringify(page)).not.toContain('payload_encrypted');
  });

  dbTest('a deleted session leaves started provenance null', async ({ db }) => {
    const { webhook, deliveries, userId, branchId } = await seed(db);
    await admit(deliveries, webhook.webhook_id);
    const current = await claim(deliveries, webhook.webhook_id);
    const sessions = new SessionRepository(db);
    const session = await sessions.create({
      branch_id: branchId,
      created_by: userId,
      agentic_tool: 'claude-code',
    });
    await deliveries.recordSession(current, session.session_id as SessionID);
    await deliveries.markFailed(current, 'permission_revoked');
    await sessions.delete(session.session_id);
    expect(await deliveries.findById(current.delivery_id)).toMatchObject({
      status: 'failed',
      session_id: null,
    });
  });
});
