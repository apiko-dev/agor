import { BranchRepository, generateId, RepoRepository, UsersRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, Session, User, ZoneTriggerModelConfig } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE } from '../utils/agentic-tool-runtime.js';
import { SessionsService } from './sessions';
import { fireAlwaysNewZoneTrigger, resolveZoneTriggerAgent } from './zone-trigger.js';

describe('resolveZoneTriggerAgent', () => {
  it('uses Claude SDK only when the persisted preference is absent', () => {
    expect(resolveZoneTriggerAgent(undefined)).toBe('claude-code');
  });

  it.each(['cursor', 'copilot'] as const)('preserves supported tool %s', (tool) => {
    expect(resolveZoneTriggerAgent(tool)).toBe(tool);
  });

  it('rejects the removed CLI preference instead of mapping it to Claude SDK', () => {
    expect(() => resolveZoneTriggerAgent('claude-code-cli')).toThrow(
      REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE
    );
  });
});

describe('fireAlwaysNewZoneTrigger', () => {
  const fire = async (modelConfig?: ZoneTriggerModelConfig) => {
    const sessionCreate = vi.fn(async (data: Partial<Session>) => ({
      ...data,
      session_id: 'session-1',
    }));
    const promptCreate = vi.fn(async () => ({ task_id: 'task-1' }));
    const app = {
      service: (path: string) =>
        path === 'sessions' ? { create: sessionCreate } : { create: promptCreate },
    };
    await fireAlwaysNewZoneTrigger({
      app,
      params: {},
      branch: { branch_id: 'branch-1', name: 'feature' } as unknown as Branch,
      board: { name: 'Board' },
      zone: {
        label: 'Review',
        trigger: {
          template: 'Review {{ branch.name }}',
          behavior: 'always_new',
          agent: 'claude-code',
          ...(modelConfig && { model_config: modelConfig }),
        },
      },
      user: { user_id: 'user-1', unix_username: 'dropper' } as unknown as User,
      userId: 'user-1',
    });
    return sessionCreate.mock.calls[0][0];
  };

  it("leaves model_config to the dropping user's defaults when the zone sets none", async () => {
    const created = await fire();
    expect(created).toMatchObject({ agentic_tool: 'claude-code', created_by: 'user-1' });
    expect(created).not.toHaveProperty('model_config');
  });
});

describe('fireAlwaysNewZoneTrigger through the sessions service', () => {
  dbTest("layers the zone's effort over the dropping user's default model", async ({ db }) => {
    const user = await new UsersRepository(db).create({
      email: `${generateId()}-zone-dropper@example.com`,
      name: 'Zone dropper',
      default_agentic_config: {
        'claude-code': {
          modelConfig: { mode: 'alias', model: 'claude-sonnet-4-6', effort: 'low' },
        },
      },
    });
    const repo = await new RepoRepository(db).create({
      slug: `zone-model-${generateId()}`,
      name: 'Zone model repo',
      repo_type: 'remote',
      remote_url: 'https://example.com/zone-model.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      repo_id: repo.repo_id,
      name: `zone-model-${generateId()}`,
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: `/tmp/${generateId()}`,
      base_ref: 'main',
      new_branch: false,
      created_by: user.user_id,
    });
    const config = { execution: { unix_user_mode: 'simple' } };
    const sessions = new SessionsService(db, {
      get: (key: string) => (key === 'config' ? config : undefined),
    } as unknown as Application);
    const app = {
      service: (path: string) =>
        path === 'sessions' ? sessions : { create: async () => ({ task_id: 'task-1' }) },
    };
    const fireWith = (modelConfig: ZoneTriggerModelConfig) =>
      fireAlwaysNewZoneTrigger({
        app,
        params: {},
        branch,
        board: { name: 'Board' },
        zone: {
          label: 'Review',
          trigger: {
            template: 'Review {{ branch.name }}',
            behavior: 'always_new',
            agent: 'claude-code',
            model_config: modelConfig,
          },
        },
        user,
        userId: user.user_id,
      });

    const effortOnly = await fireWith({ effort: 'max' });
    expect(effortOnly.session.model_config).toMatchObject({
      model: 'claude-sonnet-4-6',
      effort: 'max',
    });

    const pinned = await fireWith({ mode: 'alias', model: 'claude-opus-4-6', effort: 'high' });
    expect(pinned.session.model_config).toMatchObject({
      model: 'claude-opus-4-6',
      effort: 'high',
    });
  });
});
