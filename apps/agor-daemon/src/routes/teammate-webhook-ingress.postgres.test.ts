/**
 * Cross-tenant proof for teammate webhooks under PostgreSQL RLS: the ingress
 * tenant comes only from the webhook row, a token from one tenant cannot
 * trigger another tenant's webhook, and the worker runs each delivery inside
 * the tenant that owns it.
 */

import type { AddressInfo } from 'node:net';
import {
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  type BranchID,
  type Task,
  TaskStatus,
  type TeammateWebhookDeliveryID,
  type TeammateWebhookID,
  type TenantID,
  type UUID,
} from '@agor/core/types';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { TeammateWebhookWorker } from '../services/teammate-webhook-worker.js';
import { hashTeammateWebhookToken } from '../services/teammate-webhooks.js';
import { teammateWebhookSessionId } from '../utils/durable-task-id.js';
import { verifyIngressBodyLimit } from '../utils/ingress-body-limits.js';
import { registerTeammateWebhookIngressRoute } from './teammate-webhook-ingress';

process.env.AGOR_MASTER_SECRET ||= 'teammate-webhook-tenant-scope-test-secret';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'teammate webhooks across tenants (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL required');
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    async function seedTenant(tenantId: TenantID, token: string) {
      return runWithTenantDatabaseScope(rawDb, tenantId, async (scoped) => {
        const tx = scoped as unknown as Database;
        const user = await new UsersRepository(tx).create({
          email: `${generateId()}@example.invalid`,
          role: 'member',
        });
        const repo = await new RepoRepository(tx).create({
          slug: `webhook-tenant-${generateId()}`,
          repo_type: 'remote',
          remote_url: 'https://example.invalid/test.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(tx).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          created_by: user.user_id,
          name: 'teammate',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
          custom_context: { teammate: { kind: 'teammate' } },
        });
        const webhooks = new TeammateWebhookRepository(tx);
        const webhook = await webhooks.create({
          branch_id: branch.branch_id,
          created_by: user.user_id,
          name: `Webhook ${tenantId}`,
          prompt: 'Handle {{payload.key}}',
          agentic_tool_config: { agentic_tool: 'claude-code' },
        });
        await webhooks.setTokenHash(
          webhook.webhook_id,
          hashTeammateWebhookToken(token),
          'agwh_tttt'
        );
        return { user, webhookId: webhook.webhook_id };
      });
    }

    function inTenant<T>(tenantId: TenantID, work: (tx: Database) => Promise<T>) {
      return runWithTenantDatabaseScope(rawDb, tenantId, (scoped) =>
        work(scoped as unknown as Database)
      );
    }

    it('keeps ingress, deliveries, and runs inside the owning tenant', async () => {
      const tenantA = `tenant-a-${generateId()}` as TenantID;
      const tenantB = `tenant-b-${generateId()}` as TenantID;
      const tokenA = `agwh_${'a'.repeat(43)}`;
      const tokenB = `agwh_${'b'.repeat(43)}`;
      const a = await seedTenant(tenantA, tokenA);
      const b = await seedTenant(tenantB, tokenB);
      const db = createTenantScopedDatabaseProxy(rawDb);

      const app = express();
      app.use(express.json({ limit: '10mb', verify: verifyIngressBodyLimit }));
      registerTeammateWebhookIngressRoute({
        app: app as unknown as Application,
        db,
        wakeWorker: vi.fn(),
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const post = (webhookId: TeammateWebhookID, token: string, headers = {}) =>
        fetch(`http://127.0.0.1:${port}/webhooks/teammates/${webhookId}/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            ...headers,
          },
          body: JSON.stringify({ key: 'PROJ-1', tenant_id: tenantB }),
        });

      let deliveryA: TeammateWebhookDeliveryID;
      try {
        expect((await post(a.webhookId, tokenB)).status).toBe(404);
        expect((await post(b.webhookId, tokenA)).status).toBe(404);
        const admittedA = await post(a.webhookId, tokenA, { 'x-agor-tenant': tenantB });
        expect(admittedA.status).toBe(202);
        deliveryA = (await admittedA.json()).delivery_id;
        expect((await post(b.webhookId, tokenB)).status).toBe(202);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      const deliveries = (tenantId: TenantID, webhookId: TeammateWebhookID) =>
        inTenant(tenantId, (tx) =>
          new TeammateWebhookDeliveryRepository(tx).findByWebhook(webhookId)
        );
      expect((await deliveries(tenantA, a.webhookId)).total).toBe(1);
      expect((await deliveries(tenantB, a.webhookId)).total).toBe(0);
      expect((await deliveries(tenantB, b.webhookId)).total).toBe(1);

      const tasks = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));
      const prompt = vi.fn(async (data: { idempotencyTaskId: string }, params: any) => {
        const existing = await tasks.findById(data.idempotencyTaskId);
        if (existing) return existing;
        return tasks.create({
          task_id: data.idempotencyTaskId as Task['task_id'],
          session_id: params.route.id,
          created_by: params.user.user_id,
          status: TaskStatus.RUNNING,
        });
      });
      const workerApp = {
        get: () => undefined,
        service: (path: string) =>
          path === '/sessions/:id/prompt' ? { create: prompt } : { emit: vi.fn() },
      } as unknown as ConstructorParameters<typeof TeammateWebhookWorker>[1];
      const worker = new TeammateWebhookWorker(db, workerApp, {
        runConfig: {
          unixUserMode: 'simple',
          sdkHomeMode: 'inherit',
          deploymentPolicy: { managed: false, installed: new Set() },
          deploymentToolUnsupported: () => undefined,
          hostedOpenCode: false,
          secureLocalCredentialOverlay: false,
        },
      });
      // No fixed tenant: discovery runs under the delivery capability.
      await worker.checkOnce();

      expect(prompt).toHaveBeenCalledTimes(2);
      const sessionA = teammateWebhookSessionId(deliveryA!);
      const inA = await inTenant(tenantA, (tx) => new SessionRepository(tx).findById(sessionA));
      expect(inA?.created_by).toBe(a.user.user_id as UUID);
      expect(
        await inTenant(tenantB, (tx) => new SessionRepository(tx).findById(sessionA))
      ).toBeNull();
      const startedA = await inTenant(tenantA, (tx) =>
        new TeammateWebhookDeliveryRepository(tx).findById(deliveryA!)
      );
      expect(startedA).toMatchObject({ status: 'started', session_id: sessionA });
    });
  }
);
