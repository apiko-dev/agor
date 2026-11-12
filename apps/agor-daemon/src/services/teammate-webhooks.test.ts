/**
 * Teammate webhook authorization through the hook chain `registerHooks`
 * installs, against the real services and a migrated SQLite database.
 */

import {
  BranchRepository,
  CapabilityPolicyRepository,
  type Database,
  generateId,
  RepoRepository,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import {
  type Branch,
  type BranchID,
  type CapabilityPolicyPresetId,
  capabilityPolicyPresetCapabilities,
  TEAMMATE_WEBHOOK_DELIVERIES_SERVICE,
  TEAMMATE_WEBHOOK_TOKEN_SERVICE,
  TEAMMATE_WEBHOOKS_SERVICE,
  type TeammateWebhook,
  type TeammateWebhookIssuedToken,
  type User,
  type UserID,
} from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { REALTIME_PUBLISH_POLICY } from '../utils/realtime-publish-policy.js';
import { createTeammateWebhookServices, hashTeammateWebhookToken } from './teammate-webhooks.js';

type BranchRole = Extract<CapabilityPolicyPresetId, 'viewer' | 'collaborator' | 'manager'>;

async function seed(db: Database, options: { teammate?: boolean } = {}) {
  const users = new UsersRepository(db);
  const member = (label: string) =>
    users.create({ email: `${label}-${generateId()}@example.com`, role: 'member' });
  const owner = await member('owner');
  const manager = await member('manager');
  const collaborator = await member('collaborator');
  const viewer = await member('viewer');
  const outsider = await member('outsider');
  const superadmin = await users.create({
    email: `superadmin-${generateId()}@example.com`,
    role: 'superadmin',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `webhook-authz-${generateId()}`,
    name: 'Webhook authz',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: 'teammate-branch',
    ref: 'teammate-branch',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: owner.user_id,
    ...(options.teammate === false ? {} : { custom_context: { teammate: { kind: 'teammate' } } }),
  });
  await setBranchRoles(db, branch, owner, [
    [manager, 'manager'],
    [collaborator, 'collaborator'],
    [viewer, 'viewer'],
  ]);
  return { owner, manager, collaborator, viewer, outsider, superadmin, branch };
}

async function setBranchRoles(
  db: Database,
  branch: Branch,
  owner: User,
  grants: Array<[User, BranchRole]>
) {
  const policies = new CapabilityPolicyRepository(db);
  const current = await policies.getBranchPolicy(branch.branch_id);
  const config = structuredClone(current.override_config!);
  config.access.sharing_mode = 'shared';
  config.access.entries = grants.map(([user, preset]) => {
    const fsAccess = preset === 'viewer' ? 'none' : 'read';
    return {
      entry_id: generateId(),
      principal: { principal_type: 'user' as const, user_id: user.user_id as UserID },
      preset,
      capabilities: capabilityPolicyPresetCapabilities('branch_access', preset, fsAccess) ?? [],
      fs_access: fsAccess,
    };
  });
  await policies.replaceBranchPolicy(
    branch.branch_id,
    { ...current, override_config: config },
    owner.user_id as UserID
  );
}

function createApp(db: Database) {
  const scopedDb = db as unknown as TenantScopeAwareDatabase;
  const app = feathers() as Application;
  app.publish = () => app;
  const services = createTeammateWebhookServices(scopedDb, app);
  app.use(TEAMMATE_WEBHOOKS_SERVICE, services.webhooks);
  app.use(TEAMMATE_WEBHOOK_TOKEN_SERVICE, services.token, { methods: ['create'] });
  app.use(TEAMMATE_WEBHOOK_DELIVERIES_SERVICE, services.deliveries, { methods: ['find', 'get'] });
  const branchRows = new BranchRepository(db);
  const inert = () => ({
    async find() {
      return [];
    },
    async get() {
      return {};
    },
    async create(data: unknown) {
      return data;
    },
    async patch(_id: unknown, data: unknown) {
      return data;
    },
    async remove() {
      return {};
    },
  });
  app.use('branches', {
    ...inert(),
    async get(id: string) {
      return branchRows.findById(id);
    },
  } as never);
  for (const path of [
    'users',
    'messages',
    'repos',
    'sessions',
    'leaderboard',
    'tasks',
    'schedules',
  ]) {
    app.use(path, inert() as never);
  }
  registerHooks({
    db: scopedDb,
    app,
    config: {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'default' },
      execution: { unix_user_mode: 'simple' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'webhook-authz-integration-secret',
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: branchRows,
    usersRepository: new UsersRepository(db),
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
    deployment: { mode: 'standalone' } as RegisterHooksContext['deployment'],
  });
  return app;
}

function as(user: User, extra: Record<string, unknown> = {}) {
  return {
    provider: 'rest',
    authenticated: true,
    user: { user_id: user.user_id, email: user.email, role: user.role },
    tenant: { tenant_id: 'default', source: 'static' },
    ...extra,
  } as never;
}

const createData = (branchId: BranchID) => ({
  branch_id: branchId,
  name: 'Jira triage',
  prompt: 'Triage {{payload.issue.key}}',
  agentic_tool_config: { agentic_tool: 'claude-code' as const },
});

function seedWebhook(db: Database, branchId: BranchID, createdBy: User) {
  return new TeammateWebhookRepository(db).create({
    branch_id: branchId,
    created_by: createdBy.user_id,
    name: 'Seeded',
    prompt: 'Seeded {{payload.key}}',
    agentic_tool_config: { agentic_tool: 'claude-code' },
  });
}

const webhooks = (app: Application) => app.service(TEAMMATE_WEBHOOKS_SERVICE);
const tokens = (app: Application) => app.service(TEAMMATE_WEBHOOK_TOKEN_SERVICE);

describe('teammate webhook creation', () => {
  dbTest('admits the owner and a Manager, running as the caller', async ({ db }) => {
    const { owner, manager, branch } = await seed(db);
    const app = createApp(db);
    for (const user of [owner, manager]) {
      const created = (await webhooks(app).create(
        createData(branch.branch_id),
        as(user)
      )) as TeammateWebhook;
      expect(created).toMatchObject({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        token_hint: null,
      });
      expect(created).not.toHaveProperty('token_hash');
    }
  });

  dbTest('refuses non-Managers and superadmins without real Manager access', async ({ db }) => {
    const { collaborator, viewer, outsider, superadmin, branch } = await seed(db);
    const app = createApp(db);
    for (const user of [collaborator, viewer, outsider, superadmin]) {
      await expect(webhooks(app).create(createData(branch.branch_id), as(user))).rejects.toThrow(
        /'all' permission/
      );
    }
    expect(await new TeammateWebhookRepository(db).findAll()).toHaveLength(0);
  });

  dbTest('refuses a branch that is not a teammate', async ({ db }) => {
    const { owner, branch } = await seed(db, { teammate: false });
    await expect(
      webhooks(createApp(db)).create(createData(branch.branch_id), as(owner))
    ).rejects.toThrow(/teammate branch/);
  });

  dbTest('refuses unsafe templates and server-owned fields', async ({ db }) => {
    const { owner, branch } = await seed(db);
    const app = createApp(db);
    for (const prompt of ['{{{payload.issue}}}', '{{> partial}}', '{{lookup payload "x"}}', ' ']) {
      await expect(
        webhooks(app).create({ ...createData(branch.branch_id), prompt }, as(owner))
      ).rejects.toMatchObject({ code: 400 });
    }
    await expect(
      webhooks(app).create(
        { ...createData(branch.branch_id), token_hash: 'a'.repeat(64) } as never,
        as(owner)
      )
    ).rejects.toThrow(/unsupported write fields: token_hash/);
    await expect(
      webhooks(app).create(
        { ...createData(branch.branch_id), created_by: generateId() } as never,
        as(owner)
      )
    ).rejects.toThrow(/unsupported write fields: created_by/);
  });
});

describe('teammate webhook edits', () => {
  dbTest('only the creator may patch, even another Manager or a superadmin', async ({ db }) => {
    const { owner, manager, superadmin, branch } = await seed(db);
    const webhook = await seedWebhook(db, branch.branch_id, manager);
    const app = createApp(db);

    for (const user of [owner, superadmin]) {
      await expect(
        webhooks(app).patch(webhook.webhook_id, { prompt: 'Hijack' }, as(user))
      ).rejects.toMatchObject({ code: 403 });
    }
    const patched = (await webhooks(app).patch(
      webhook.webhook_id,
      { prompt: 'Updated {{payload.key}}', enabled: false },
      as(manager)
    )) as TeammateWebhook;
    expect(patched).toMatchObject({ prompt: 'Updated {{payload.key}}', enabled: false });
    await expect(
      webhooks(app).patch(webhook.webhook_id, { prompt: '{{{payload}}}' }, as(manager))
    ).rejects.toMatchObject({ code: 400 });
  });

  dbTest('refuses a creator demoted below Manager', async ({ db }) => {
    const { owner, manager, collaborator, viewer, branch } = await seed(db);
    const webhook = await seedWebhook(db, branch.branch_id, manager);
    await setBranchRoles(db, branch, owner, [
      [manager, 'collaborator'],
      [collaborator, 'collaborator'],
      [viewer, 'viewer'],
    ]);
    await expect(
      webhooks(createApp(db)).patch(webhook.webhook_id, { enabled: false }, as(manager))
    ).rejects.toThrow(/'all' permission/);
  });

  dbTest('any Manager may delete; a Collaborator may not', async ({ db }) => {
    const { owner, manager, collaborator, branch } = await seed(db);
    const app = createApp(db);
    const webhook = await seedWebhook(db, branch.branch_id, owner);
    await expect(webhooks(app).remove(webhook.webhook_id, as(collaborator))).rejects.toThrow(
      /'all' permission/
    );
    await webhooks(app).remove(webhook.webhook_id, as(manager));
    expect(await new TeammateWebhookRepository(db).findById(webhook.webhook_id)).toBeNull();
  });
});

describe('teammate webhook reads follow branch visibility', () => {
  dbTest(
    'hides webhooks and deliveries from callers who cannot view the branch',
    async ({ db }) => {
      const { owner, viewer, outsider, branch } = await seed(db);
      const webhook = await seedWebhook(db, branch.branch_id, owner);
      const app = createApp(db);

      const outsiderList = (await webhooks(app).find(as(outsider))) as { data: TeammateWebhook[] };
      expect(outsiderList.data).toEqual([]);
      await expect(webhooks(app).get(webhook.webhook_id, as(outsider))).rejects.toThrow(
        /permission/
      );
      await expect(
        app
          .service(TEAMMATE_WEBHOOK_DELIVERIES_SERVICE)
          .find(as(outsider, { query: { webhook_id: webhook.webhook_id } }))
      ).rejects.toThrow(/permission/);

      const viewerList = (await webhooks(app).find(
        as(viewer, { query: { branch_id: branch.branch_id } })
      )) as { data: TeammateWebhook[] };
      expect(viewerList.data.map((row) => row.webhook_id)).toEqual([webhook.webhook_id]);
      const deliveries = (await app
        .service(TEAMMATE_WEBHOOK_DELIVERIES_SERVICE)
        .find(as(viewer, { query: { webhook_id: webhook.webhook_id } }))) as { total: number };
      expect(deliveries.total).toBe(0);
    }
  );

  dbTest('never exposes delivery payloads', async ({ db }) => {
    const { owner, branch } = await seed(db);
    const webhook = await seedWebhook(db, branch.branch_id, owner);
    const admitted = await new TeammateWebhookDeliveryRepository(db).admit({
      webhookId: webhook.webhook_id,
      idempotencyKey: null,
      payload: { secret: 'payload-marker' },
      payloadBytes: 30,
    });
    if (admitted.outcome === 'rejected') throw new Error('delivery was not admitted');
    const app = createApp(db);
    const service = app.service(TEAMMATE_WEBHOOK_DELIVERIES_SERVICE);
    const listed = await service.find(as(owner, { query: { webhook_id: webhook.webhook_id } }));
    const fetched = await service.get(admitted.delivery.delivery_id, as(owner));
    expect(JSON.stringify([listed, fetched])).not.toContain('payload-marker');
    expect(fetched).toMatchObject({ status: 'queued', webhook_id: webhook.webhook_id });
  });
});

describe('teammate webhook token issuance', () => {
  dbTest('issues to the creator only and rotates the credential', async ({ db }) => {
    const { owner, manager, superadmin, branch } = await seed(db);
    const webhook = await seedWebhook(db, branch.branch_id, manager);
    const app = createApp(db);
    const published: unknown[] = [];
    webhooks(app).on('patched', (data: unknown) => published.push(data));
    tokens(app).on('created', (data: unknown) => published.push(data));

    for (const user of [owner, superadmin]) {
      await expect(
        tokens(app).create({}, as(user, { route: { id: webhook.webhook_id } }))
      ).rejects.toMatchObject({ code: 403 });
    }

    const issue = () =>
      tokens(app).create(
        {},
        as(manager, { route: { id: webhook.webhook_id } })
      ) as Promise<TeammateWebhookIssuedToken>;
    const first = await issue();
    expect(first.token).toMatch(/^agwh_[A-Za-z0-9_-]{43}$/);
    expect(first.token_hint).toBe(first.token.slice(0, 9));
    expect(first).toMatchObject({
      webhook_id: webhook.webhook_id,
      ingress_url: expect.any(String),
    });
    expect(first.ingress_url).toMatch(new RegExp(`/webhooks/teammates/${webhook.webhook_id}/$`));

    const repo = new TeammateWebhookRepository(db);
    expect((await repo.findIngressCredential(webhook.webhook_id))?.token_hash).toBe(
      hashTeammateWebhookToken(first.token)
    );
    const second = await issue();
    expect(second.token).not.toBe(first.token);
    expect((await repo.findIngressCredential(webhook.webhook_id))?.token_hash).toBe(
      hashTeammateWebhookToken(second.token)
    );

    const read = [
      await webhooks(app).get(webhook.webhook_id, as(manager)),
      await webhooks(app).find(as(manager)),
    ];
    expect(read[0]).toMatchObject({ token_hint: second.token_hint });
    for (const surface of [read, published]) {
      const serialized = JSON.stringify(surface);
      expect(serialized).not.toContain(first.token);
      expect(serialized).not.toContain(second.token);
      expect(serialized).not.toContain('token_hash');
    }
    expect(published.length).toBeGreaterThan(0);
  });

  dbTest('the token route never fans out over realtime', () => {
    expect(REALTIME_PUBLISH_POLICY[TEAMMATE_WEBHOOK_TOKEN_SERVICE].audience).toBe('none');
    expect(REALTIME_PUBLISH_POLICY[TEAMMATE_WEBHOOKS_SERVICE].audience).toBe('branch');
    expect(REALTIME_PUBLISH_POLICY[TEAMMATE_WEBHOOK_DELIVERIES_SERVICE].audience).toBe('branch');
  });
});
