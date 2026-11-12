/**
 * PostgreSQL tenant isolation and HA claims for teammate webhooks.
 *
 * Run with:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/repositories/teammate-webhooks.postgres.test.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, UUID } from '../../types/id';
import type { TeammateWebhook } from '../../types/teammate-webhook';
import { createDatabase, type Database } from '../client';
import { executeRaw, isPostgresDatabase } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { TeammateWebhookDeliveryRepository } from './teammate-webhook-deliveries';
import { TeammateWebhookRepository } from './teammate-webhooks';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
let branchUnique = Date.now() % 1_000_000;
const LEASE = { leaseMs: 60_000, busyDelayMs: 15_000 };

async function seedTenant(db: Database, tenantId: string): Promise<TeammateWebhook> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${tenantId}-${generateId()}@example.com`,
      name: `Webhook ${tenantId}`,
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `webhook-${tenantId}-${generateId()}`,
      name: `Webhook ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/webhooks.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `webhook-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/tmp/${generateId()}`,
      created_by: user.user_id,
    });
    const webhooks = new TeammateWebhookRepository(scoped);
    const webhook = await webhooks.create({
      branch_id: branch.branch_id as BranchID,
      created_by: user.user_id as UUID,
      name: `Webhook ${tenantId}`,
      prompt: 'Handle {{payload.id}}',
      agentic_tool_config: { agentic_tool: 'claude-code' },
    });
    await webhooks.setTokenHash(webhook.webhook_id, 'c'.repeat(64), 'agwh_cccc');
    return webhook;
  });
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('teammate webhooks (PostgreSQL)', () => {
  let db: Database;
  let tenantA: string;
  let tenantB: string;
  let webhookA: TeammateWebhook;
  let webhookB: TeammateWebhook;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    tenantA = `webhook-a-${generateId()}`;
    tenantB = `webhook-b-${generateId()}`;
    webhookA = await seedTenant(db, tenantA);
    webhookB = await seedTenant(db, tenantB);
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  it('isolates webhooks and deliveries between tenants', async () => {
    await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
      new TeammateWebhookDeliveryRepository(scoped).admit({
        webhookId: webhookA.webhook_id,
        idempotencyKey: 'a-1',
        payload: { id: 1 },
        payloadBytes: 8,
      })
    );
    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      const webhooks = new TeammateWebhookRepository(scoped);
      const deliveries = new TeammateWebhookDeliveryRepository(scoped);
      expect(await webhooks.findById(webhookA.webhook_id)).toBeNull();
      expect(await webhooks.findIngressCredential(webhookA.webhook_id)).toBeNull();
      expect((await deliveries.findByWebhook(webhookA.webhook_id)).total).toBe(0);
      // A webhook id from another tenant cannot be admitted into this one.
      expect(
        await deliveries.admit({
          webhookId: webhookA.webhook_id,
          idempotencyKey: null,
          payload: {},
          payloadBytes: 2,
        })
      ).toEqual({ outcome: 'rejected', reason: 'webhook_unavailable' });
      expect((await webhooks.findAll()).map((webhook) => webhook.webhook_id)).toEqual([
        webhookB.webhook_id,
      ]);
    });
  });

  it('maps an enabled webhook id to its tenant under the ingress capability only', async () => {
    const lookup = (webhookId: TeammateWebhook['webhook_id']) =>
      runWithSystemDatabaseScope(
        db,
        'teammate webhook ingress test',
        (systemDb) =>
          new TeammateWebhookRepository(systemDb).findIngressTenantId(systemDb, webhookId),
        { capability: 'teammate_webhook_ingress_discovery' }
      );
    expect(await lookup(webhookA.webhook_id)).toBe(tenantA);
    expect(await lookup(webhookB.webhook_id)).toBe(tenantB);

    const withoutCapability = await runWithSystemDatabaseScope(
      db,
      'teammate webhook ingress test without capability',
      (systemDb) =>
        new TeammateWebhookRepository(systemDb).findIngressTenantId(systemDb, webhookA.webhook_id),
      { capability: 'teammate_webhook_delivery_discovery' }
    );
    expect(withoutCapability).toBeNull();

    const disabled = await seedTenant(db, `webhook-disabled-${generateId()}`);
    const disabledTenant = (disabled as unknown as { tenant_id: string }).tenant_id;
    await runWithTenantDatabaseScope(db, disabledTenant, (scoped) =>
      new TeammateWebhookRepository(scoped).update(disabled.webhook_id, { enabled: false })
    );
    expect(await lookup(disabled.webhook_id)).toBeNull();
  });

  it('the ingress capability cannot write webhooks', async () => {
    const changed = await runWithSystemDatabaseScope(
      db,
      'teammate webhook ingress write attempt',
      async (systemDb) =>
        executeRaw(
          systemDb,
          sql`UPDATE teammate_webhooks SET token_hash = NULL WHERE webhook_id = ${webhookA.webhook_id} RETURNING webhook_id`
        ),
      { capability: 'teammate_webhook_ingress_discovery' }
    );
    expect(JSON.stringify(changed)).not.toContain(webhookA.webhook_id);
    const credential = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
      new TeammateWebhookRepository(scoped).findIngressCredential(webhookA.webhook_id)
    );
    expect(credential?.token_hash).toBe('c'.repeat(64));
  });

  it('discovers due deliveries across tenants with routing ids only', async () => {
    await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
      new TeammateWebhookDeliveryRepository(scoped).admit({
        webhookId: webhookB.webhook_id,
        idempotencyKey: null,
        payload: { id: 2 },
        payloadBytes: 8,
      })
    );
    const refs = await runWithSystemDatabaseScope(
      db,
      'teammate webhook delivery discovery test',
      (systemDb) =>
        new TeammateWebhookDeliveryRepository(systemDb).findDueWebhookRefs(systemDb, {
          limit: 1_000,
        }),
      { capability: 'teammate_webhook_delivery_discovery' }
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        { tenant_id: tenantA, webhook_id: webhookA.webhook_id },
        { tenant_id: tenantB, webhook_id: webhookB.webhook_id },
      ])
    );

    const writes = await runWithSystemDatabaseScope(
      db,
      'teammate webhook delivery write attempt',
      async (systemDb) =>
        executeRaw(
          systemDb,
          sql`UPDATE teammate_webhook_deliveries SET status = 'failed' RETURNING delivery_id`
        ),
      { capability: 'teammate_webhook_delivery_discovery' }
    );
    expect(JSON.stringify(writes)).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('lets exactly one of two concurrent claimers own the FIFO head', async () => {
    const webhook = await seedTenant(db, `webhook-race-${generateId()}`);
    const tenant = (webhook as unknown as { tenant_id: string }).tenant_id;
    await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
      const deliveries = new TeammateWebhookDeliveryRepository(scoped);
      for (let index = 0; index < 2; index++) {
        await deliveries.admit({
          webhookId: webhook.webhook_id,
          idempotencyKey: null,
          payload: { index },
          payloadBytes: 8,
        });
      }
    });
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        runWithTenantDatabaseScope(db, tenant, (scoped) =>
          new TeammateWebhookDeliveryRepository(scoped).claimNext(webhook.webhook_id, LEASE)
        )
      )
    );
    expect(results.map((result) => result.kind).sort()).toEqual(['busy', 'claimed']);
  });

  it('keeps idempotency keys per tenant and webhook', async () => {
    const result = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const deliveries = new TeammateWebhookDeliveryRepository(scoped);
      const input = {
        webhookId: webhookA.webhook_id,
        idempotencyKey: 'a-1',
        payload: { id: 1 },
        payloadBytes: 8,
      };
      return deliveries.admit(input);
    });
    expect(result.outcome).toBe('duplicate');
  });
});
