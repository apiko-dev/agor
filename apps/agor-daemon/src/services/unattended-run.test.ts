import { UsersRepository } from '@agor/core/db';
import type { Branch, BranchID, Session, TaskID, User, UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  dispatchUnattendedPrompt,
  prepareUnattendedRun,
  resolveUnattendedMcpServerIds,
  type UnattendedRunDeps,
  UnattendedRunRevokedError,
} from './unattended-run';

const BRANCH = { branch_id: 'b1' as BranchID, mcp_server_ids: ['branch-mcp'] } as Branch;
const MEMBER = { user_id: 'u1', email: 'owner@example.com', role: 'member' } as unknown as User;
const RUN_AS = 'u1' as UUID;

function makeDeps(
  db: UnattendedRunDeps['db'],
  overrides: {
    branch?: Branch | null;
    access?: 'all' | 'prompt' | 'view';
    creator?: User | null;
    promptAllowed?: boolean;
    unixUserMode?: UnattendedRunDeps['unixUserMode'];
    installed?: string[];
  } = {}
) {
  const prompt = vi.fn(async () => ({ task_id: 'task-1' }));
  const deps = {
    app: { service: () => ({ create: prompt }) },
    db,
    branchRepo: {
      findById: vi.fn(async () => (overrides.branch === undefined ? BRANCH : overrides.branch)),
      resolveUserAccess: vi.fn(async () => ({ can: overrides.access ?? 'all' })),
      resolveSessionPromptAuthority: vi.fn(async () => ({
        allowed: overrides.promptAllowed ?? true,
      })),
    },
    userRepo: {
      findById: vi.fn(async () => (overrides.creator === undefined ? MEMBER : overrides.creator)),
    },
    sessionMCPRepo: {},
    unixUserMode: overrides.unixUserMode ?? 'simple',
    sdkHomeMode: 'inherit',
    deploymentPolicy: { managed: true, installed: new Set(overrides.installed ?? []) },
    deploymentToolUnsupported: () => undefined,
    hostedOpenCode: false,
    secureLocalCredentialOverlay: false,
  } as unknown as UnattendedRunDeps;
  return { deps, prompt };
}

/** Config materialization reads the run-as user from the database. */
async function seededInput(db: UnattendedRunDeps['db']) {
  const owner = await new UsersRepository(db).create({ email: 'owner@example.com', name: 'Owner' });
  return {
    branchId: BRANCH.branch_id,
    runAsUserId: owner.user_id as UUID,
    agenticToolConfig: { agentic_tool: 'claude-code' } as const,
    mcpServerIds: undefined,
  };
}

describe('resolveUnattendedMcpServerIds', () => {
  it('prefers explicit ids, even an empty list, over the branch default', () => {
    expect(resolveUnattendedMcpServerIds(['own'], BRANCH)).toEqual(['own']);
    expect(resolveUnattendedMcpServerIds([], BRANCH)).toEqual([]);
    expect(resolveUnattendedMcpServerIds(undefined, BRANCH)).toEqual(['branch-mcp']);
    expect(resolveUnattendedMcpServerIds(undefined, { mcp_server_ids: [] })).toEqual([]);
  });
});

describe('prepareUnattendedRun', () => {
  const cases = [
    ['branch_missing', { branch: null }],
    ['permission_revoked', { access: 'prompt' }],
    ['creator_missing', { creator: null }],
    ['creator_home_key_missing', { unixUserMode: 'delegated' }],
    ['permission_revoked', { creator: { ...MEMBER, role: 'viewer' } }],
    ['tool_unavailable', { installed: [] }],
  ] as const;
  for (const [code, overrides] of cases) {
    dbTest(`rejects with ${code} (${JSON.stringify(overrides)})`, async ({ db }) => {
      const { deps } = makeDeps(db, overrides);
      const result = await prepareUnattendedRun(deps, await seededInput(db));
      expect(result).toMatchObject({ ok: false, rejection: { code } });
    });
  }

  dbTest('prepares a run with the branch MCP default when the gates pass', async ({ db }) => {
    const { deps } = makeDeps(db, { installed: ['claude-code'] });
    const input = await seededInput(db);
    const result = await prepareUnattendedRun(deps, input);
    expect(result).toMatchObject({
      ok: true,
      run: {
        activeTool: 'claude-code',
        runAsUserId: input.runAsUserId,
        mcpServerIds: ['branch-mcp'],
      },
    });
  });
});

describe('dispatchUnattendedPrompt', () => {
  const session = {
    session_id: 's1',
    branch_id: BRANCH.branch_id,
    created_by: RUN_AS,
    sdk_home_scope: 'user',
  } as unknown as Session;
  const input = {
    session,
    creator: MEMBER,
    prompt: 'do it',
    taskId: 'task-1' as TaskID,
    taskAlreadyAdmitted: false,
  };

  dbTest('refuses a revoked creator before admitting a task', async ({ db }) => {
    const { deps, prompt } = makeDeps(db, { promptAllowed: false });
    await expect(dispatchUnattendedPrompt(deps, input)).rejects.toBeInstanceOf(
      UnattendedRunRevokedError
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  dbTest('reconciles an already-admitted task without rechecking authority', async ({ db }) => {
    const { deps, prompt } = makeDeps(db, { promptAllowed: false });
    await dispatchUnattendedPrompt(deps, { ...input, taskAlreadyAdmitted: true });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'do it', idempotencyTaskId: 'task-1' }),
      expect.objectContaining({ route: { id: 's1' }, provider: undefined, user: MEMBER })
    );
  });
});
