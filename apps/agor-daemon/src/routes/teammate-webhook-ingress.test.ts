import type { AddressInfo } from 'node:net';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  RepoRepository,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BranchID, TeammateWebhook } from '@agor/core/types';
import express from 'express';
import { afterEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { hashTeammateWebhookToken } from '../services/teammate-webhooks.js';
import { verifyIngressBodyLimit } from '../utils/ingress-body-limits.js';
import { registerTeammateWebhookIngressRoute } from './teammate-webhook-ingress';

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = `agwh_${'A'.repeat(43)}`;
const OTHER_TOKEN = `agwh_${'B'.repeat(43)}`;

async function seedWebhook(
  db: Database,
  options: { teammate?: boolean; token?: string | null; enabled?: boolean } = {}
): Promise<TeammateWebhook> {
  const owner = await new UsersRepository(db).create({
    email: `owner-${generateId()}@example.com`,
    role: 'member',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `webhook-ingress-${generateId()}`,
    name: 'Webhook ingress',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'teammate',
    ref: 'teammate',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    created_by: owner.user_id,
    ...(options.teammate === false ? {} : { custom_context: { teammate: { kind: 'teammate' } } }),
  });
  const webhooks = new TeammateWebhookRepository(db);
  const webhook = await webhooks.create({
    branch_id: branch.branch_id,
    created_by: owner.user_id,
    name: 'Jira',
    prompt: 'Triage {{payload.issue.key}}',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: options.enabled ?? true,
  });
  const token = options.token === undefined ? TOKEN : options.token;
  if (token)
    await webhooks.setTokenHash(webhook.webhook_id, hashTeammateWebhookToken(token), 'agwh_AAAA');
  return webhook;
}

async function withRoute(
  db: Database,
  run: (fixture: {
    post: (
      webhookId: string,
      init?: {
        token?: string | null;
        query?: boolean;
        body?: string;
        headers?: Record<string, string>;
        slash?: boolean;
      }
    ) => Promise<globalThis.Response>;
    wakeWorker: ReturnType<typeof vi.fn>;
  }) => Promise<void>
) {
  const app = express();
  app.use(express.json({ limit: '10mb', verify: verifyIngressBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: '10mb', verify: verifyIngressBodyLimit }));
  const wakeWorker = vi.fn();
  registerTeammateWebhookIngressRoute({
    app: app as unknown as Application,
    db: createTenantScopedDatabaseProxy(db),
    wakeWorker,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({
      wakeWorker,
      post: (webhookId, init = {}) => {
        const token = init.token === undefined ? TOKEN : init.token;
        const query = token && init.query ? `?token=${encodeURIComponent(token)}` : '';
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(token && !init.query ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        };
        return fetch(
          `http://127.0.0.1:${port}/webhooks/teammates/${webhookId}${init.slash === false ? '' : '/'}${query}`,
          {
            method: 'POST',
            headers,
            body: init.body ?? JSON.stringify({ issue: { key: 'PROJ-42' } }),
          }
        );
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('teammate webhook ingress', () => {
  dbTest(
    'admits a call by header or query token, with or without a trailing slash',
    async ({ db }) => {
      const webhook = await seedWebhook(db);
      await withRoute(db, async ({ post, wakeWorker }) => {
        const byHeader = await post(webhook.webhook_id);
        expect(byHeader.status).toBe(202);
        expect(byHeader.headers.get('cache-control')).toBe('no-store');
        expect(byHeader.headers.get('referrer-policy')).toBe('no-referrer');
        const body = await byHeader.json();
        expect(body).toEqual({
          delivery_id: expect.any(String),
          status: 'queued',
          duplicate: false,
        });

        const byQuery = await post(webhook.webhook_id, { query: true, slash: false });
        expect(byQuery.status).toBe(202);
        const empty = await post(webhook.webhook_id, { body: '', headers: {} });
        expect(empty.status).toBe(202);
        expect(wakeWorker).toHaveBeenCalledTimes(3);
      });
      const deliveries = await new TeammateWebhookDeliveryRepository(db).findByWebhook(
        webhook.webhook_id
      );
      expect(deliveries.total).toBe(3);
    }
  );

  dbTest('deduplicates on the first idempotency header present', async ({ db }) => {
    const webhook = await seedWebhook(db);
    await withRoute(db, async ({ post, wakeWorker }) => {
      const headers = { 'x-atlassian-webhook-identifier': 'jira-delivery-1' };
      const first = await (await post(webhook.webhook_id, { headers })).json();
      const again = await post(webhook.webhook_id, { headers });
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({ ...first, duplicate: true });
      expect(wakeWorker).toHaveBeenCalledTimes(1);
    });
  });

  dbTest('requires a token, and answers every other rejection with one 404', async ({ db }) => {
    const live = await seedWebhook(db);
    const disabled = await seedWebhook(db, { enabled: false });
    const noToken = await seedWebhook(db, { token: null });
    const notTeammate = await seedWebhook(db, { teammate: false });
    await withRoute(db, async ({ post }) => {
      const missing = await post(live.webhook_id, { token: null });
      expect(missing.status).toBe(401);

      const rejected = [
        await post(live.webhook_id, { token: OTHER_TOKEN }),
        await post(generateId()),
        await post('not-a-uuid'),
        await post(disabled.webhook_id),
        await post(noToken.webhook_id),
        await post(notTeammate.webhook_id),
      ];
      const bodies = await Promise.all(rejected.map((response) => response.text()));
      expect(rejected.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
      expect(new Set(bodies)).toEqual(new Set(['{"error":"Webhook not found"}']));
    });
    expect(
      (await new TeammateWebhookDeliveryRepository(db).findByWebhook(live.webhook_id)).total
    ).toBe(0);
  });

  dbTest(
    'rejects oversized, non-JSON, and malformed bodies without echoing them',
    async ({ db }) => {
      const webhook = await seedWebhook(db);
      await withRoute(db, async ({ post }) => {
        const huge = await post(webhook.webhook_id, {
          body: JSON.stringify({ blob: 'x'.repeat(1_100_000) }),
        });
        expect(huge.status).toBe(413);
        const text = await post(webhook.webhook_id, {
          body: 'payload-marker',
          headers: { 'content-type': 'text/plain' },
        });
        expect(text.status).toBe(415);
        const malformed = await post(webhook.webhook_id, { body: '{"payload-marker": ' });
        expect(malformed.status).toBe(400);
        const primitive = await post(webhook.webhook_id, { body: '"payload-marker"' });
        expect(primitive.status).toBe(400);
        for (const response of [huge, text, malformed, primitive]) {
          expect(await response.text()).not.toContain('payload-marker');
        }
      });
    }
  );

  dbTest('reports a full queue as 429 and a failed admission as 503', async ({ db }) => {
    const webhook = await seedWebhook(db);
    const deliveries = new TeammateWebhookDeliveryRepository(db);
    await withRoute(db, async ({ post }) => {
      const admit = vi
        .spyOn(TeammateWebhookDeliveryRepository.prototype, 'admit')
        .mockRejectedValueOnce(new Error(`database down ${TOKEN}`));
      const unavailable = await post(webhook.webhook_id);
      expect(unavailable.status).toBe(503);
      admit.mockRestore();

      for (let i = 0; i < 100; i += 1) {
        await deliveries.admit({
          webhookId: webhook.webhook_id,
          idempotencyKey: null,
          payload: {},
          payloadBytes: 2,
        });
      }
      const full = await post(webhook.webhook_id);
      expect(full.status).toBe(429);
      expect(await full.json()).toMatchObject({ code: 'queue_full' });
    });
  });

  dbTest('rate limits failed calls per webhook and source', async ({ db }) => {
    const attacked = await seedWebhook(db);
    const other = await seedWebhook(db);
    await withRoute(db, async ({ post }) => {
      for (let i = 0; i < 60; i += 1) {
        expect((await post(attacked.webhook_id, { token: OTHER_TOKEN })).status).toBe(404);
      }
      expect((await post(attacked.webhook_id)).status).toBe(429);
      expect((await post(other.webhook_id)).status).toBe(202);
    });
  });

  dbTest('never logs the token or the payload', async ({ db }) => {
    const webhook = await seedWebhook(db);
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    await withRoute(db, async ({ post }) => {
      vi.spyOn(TeammateWebhookDeliveryRepository.prototype, 'admit').mockRejectedValueOnce(
        new Error(`payload-marker ${TOKEN}`)
      );
      await post(webhook.webhook_id, { query: true, body: '{"secret":"payload-marker"}' });
      await post(webhook.webhook_id, { token: OTHER_TOKEN, body: '{"secret":"payload-marker"}' });
      await post(webhook.webhook_id, { body: '{"payload-marker": ' });
    });
    const logged = lines.join('\n');
    expect(logged).toContain('event=admission_failed');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(OTHER_TOKEN);
    expect(logged).not.toContain('payload-marker');
  });
});
