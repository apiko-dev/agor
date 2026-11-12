/**
 * Unattended run launcher
 *
 * The trigger-independent half of starting an agent run with nobody at the
 * keyboard: the run-as gate, live agentic configuration, deployment and tenant
 * tool gates, SDK-home admission, MCP attachment, the prompt-authority recheck,
 * and the internal first-prompt dispatch. Callers own their trigger identity,
 * admission transaction, dedupe, retry and recovery.
 *
 * Call order: `prepareUnattendedRun` (no writes) -> caller's admission
 * transaction around `admitUnattendedSessionRow` + its own insert ->
 * `attachUnattendedMcpServers` -> `dispatchUnattendedPrompt`.
 *
 * Contract: permanent refusals are typed (`UnattendedRunRejection`,
 * `UnattendedRunRevokedError`). Every other thrown error is transient.
 */

import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import {
  type DeploymentAgenticToolPolicy,
  InvalidScheduleAgenticToolConfigError,
  isDeploymentAgenticToolAvailable,
  isTenantAgenticToolEnabled,
  normalizePersistedScheduleAgenticToolConfig,
  unixUserModeRequiresExecutionHomeKey,
} from '@agor/core/config';
import type {
  BranchRepository,
  SessionMCPServerRepository,
  TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { EntityNotFoundError, getCurrentTenantId, runWithTenantDatabaseScope } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  AgenticToolName,
  AuthenticatedParams,
  Branch,
  BranchID,
  MCPServerID,
  PersistedScheduleAgenticToolConfig,
  Session,
  SessionID,
  Task,
  TaskID,
  User,
  UserID,
  UUID,
} from '@agor/core/types';
import { hasMinimumRole, isAgenticToolName, ROLES, SessionStatus } from '@agor/core/types';
import type { UnixUserMode } from '@agor/core/unix';
import {
  resolveBranchSdkHomeIncompatibility,
  resolveNewSessionSdkHomeScope,
  type SdkHomeMode,
} from '../branch-sdk-home.js';
import type { Application } from '../declarations';
import {
  materializedAgenticToolConfigurationToScheduleConfig,
  scheduleAgenticToolConfigToSource,
} from '../utils/agentic-configuration-sources.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';

/** Repositories must already be bound to the tenant unit of work by the caller. */
export interface UnattendedRunDeps {
  app: Application;
  db: TenantScopeAwareDatabase;
  branchRepo: BranchRepository;
  userRepo: UsersRepository;
  sessionMCPRepo: SessionMCPServerRepository;
  unixUserMode: UnixUserMode;
  sdkHomeMode: SdkHomeMode;
  deploymentPolicy: DeploymentAgenticToolPolicy;
  deploymentToolUnsupported: (tool: AgenticToolName) => BadRequest | undefined;
  hostedOpenCode: boolean;
  secureLocalCredentialOverlay: boolean;
}

export type UnattendedRunRejection =
  | { code: 'branch_missing' }
  | { code: 'permission_revoked' }
  | { code: 'creator_missing' }
  | { code: 'creator_home_key_missing'; creator: User }
  | { code: 'agentic_tool_removed' }
  | { code: 'invalid_config'; message: string }
  | { code: 'tool_unavailable'; error: BadRequest };

export type UnattendedRunPreparation =
  | { ok: true; run: PreparedUnattendedRun }
  | { ok: false; rejection: UnattendedRunRejection };

export interface ResolvedUnattendedAgenticToolConfig {
  activeTool: AgenticToolName;
  config: PersistedScheduleAgenticToolConfig;
  sessionConfig: Awaited<ReturnType<typeof materializeAgenticToolConfiguration>>;
}

export interface PreparedUnattendedRun extends ResolvedUnattendedAgenticToolConfig {
  branch: Branch;
  runAsUserId: UUID;
  creator: User;
  unixUsername: string | null;
  mcpServerIds: string[];
  branchSdkHomeIncompatibility: string | undefined;
}

/** The run-as user lost branch Manager or tenant Member authority before the first Task. */
export class UnattendedRunRevokedError extends Error {
  constructor() {
    super('Unattended run creator no longer has authority to prompt this session');
    this.name = 'UnattendedRunRevokedError';
  }
}

function withTenantDatabase<T>(deps: UnattendedRunDeps, work: () => Promise<T>): Promise<T> {
  return runWithTenantDatabaseScope(deps.db, getCurrentTenantId(), work);
}

/** Explicit ids win, even when empty; otherwise the branch default. */
export function resolveUnattendedMcpServerIds(
  explicit: string[] | undefined,
  branch: Pick<Branch, 'mcp_server_ids'>
): string[] {
  if (explicit !== undefined) return explicit;
  return branch.mcp_server_ids && branch.mcp_server_ids.length > 0 ? branch.mcp_server_ids : [];
}

/** Resolve a persisted source (presets read live) into session-ready configuration. */
export async function resolveUnattendedAgenticToolConfig(
  db: TenantScopeAwareDatabase,
  input: { agenticToolConfig: PersistedScheduleAgenticToolConfig; runAsUserId: UUID }
): Promise<ResolvedUnattendedAgenticToolConfig> {
  const cfg = normalizePersistedScheduleAgenticToolConfig(input.agenticToolConfig);
  const materialized = await materializeAgenticToolConfiguration(db, {
    tool: cfg.agentic_tool,
    source: scheduleAgenticToolConfigToSource(cfg),
    executionOwnerId: input.runAsUserId as UserID,
  });
  return {
    activeTool: cfg.agentic_tool,
    config: materializedAgenticToolConfigurationToScheduleConfig(cfg, materialized),
    sessionConfig: materialized,
  };
}

/** Run-as gate (branch Manager + tenant Member), live config, and tool gates. No writes. */
export async function prepareUnattendedRun(
  deps: UnattendedRunDeps,
  input: {
    branchId: BranchID;
    runAsUserId: UUID;
    agenticToolConfig: PersistedScheduleAgenticToolConfig;
    mcpServerIds: string[] | undefined;
  }
): Promise<UnattendedRunPreparation> {
  const reject = (rejection: UnattendedRunRejection) => ({ ok: false, rejection }) as const;
  const branch = await withTenantDatabase(deps, () => deps.branchRepo.findById(input.branchId));
  if (!branch) return reject({ code: 'branch_missing' });
  const access = await withTenantDatabase(deps, () =>
    deps.branchRepo.resolveUserAccess(branch, input.runAsUserId)
  );
  if (access.can !== 'all') return reject({ code: 'permission_revoked' });
  const creator = await withTenantDatabase(deps, () => deps.userRepo.findById(input.runAsUserId));
  if (!creator) return reject({ code: 'creator_missing' });
  const unixUsername = creator.unix_username || null;
  if (!unixUsername && unixUserModeRequiresExecutionHomeKey(deps.unixUserMode)) {
    return reject({ code: 'creator_home_key_missing', creator });
  }
  if (!hasMinimumRole(creator.role, ROLES.MEMBER)) return reject({ code: 'permission_revoked' });

  let resolved: ResolvedUnattendedAgenticToolConfig;
  try {
    resolved = await withTenantDatabase(deps, () =>
      resolveUnattendedAgenticToolConfig(deps.db, input)
    );
  } catch (error) {
    if (!(error instanceof InvalidScheduleAgenticToolConfigError)) throw error;
    return reject(
      isAgenticToolName(input.agenticToolConfig.agentic_tool)
        ? { code: 'invalid_config', message: error.message }
        : { code: 'agentic_tool_removed' }
    );
  }
  const { activeTool } = resolved;
  if (!isDeploymentAgenticToolAvailable(activeTool, deps.deploymentPolicy)) {
    return reject({
      code: 'tool_unavailable',
      error: new BadRequest(`${activeTool} is not installed for this deployment`),
    });
  }
  const unsupported = deps.deploymentToolUnsupported(activeTool);
  if (unsupported) return reject({ code: 'tool_unavailable', error: unsupported });
  if (!(await withTenantDatabase(deps, () => isTenantAgenticToolEnabled(activeTool, deps.db)))) {
    return reject({
      code: 'tool_unavailable',
      error: new BadRequest(`${activeTool} is disabled for this workspace`),
    });
  }
  // Native Codex auth cannot be projected safely into branch-owned state.
  // Resolve it before admission so a rejected run cannot leave an
  // otherwise-unused branch permanently adopted. Executor startup repeats
  // the check for defense in depth and actor-sensitive shared prompts.
  const branchSdkHomeIncompatibility = await withTenantDatabase(deps, () =>
    resolveBranchSdkHomeIncompatibility({
      tool: activeTool,
      delegated: deps.unixUserMode === 'delegated',
      hostedOpenCode: deps.hostedOpenCode,
      secureLocalCredentialOverlay: deps.secureLocalCredentialOverlay,
      userId: input.runAsUserId as UserID,
      db: deps.db,
    })
  );
  return {
    ok: true,
    run: {
      ...resolved,
      branch,
      runAsUserId: input.runAsUserId,
      creator,
      unixUsername,
      mcpServerIds: resolveUnattendedMcpServerIds(input.mcpServerIds, branch),
      branchSdkHomeIncompatibility,
    },
  };
}

/**
 * Call inside the caller's admission transaction: SDK-home admission (may adopt
 * the branch home) and the Session row to insert. `extra` carries the
 * trigger-specific columns and wins over the shared ones.
 */
export async function admitUnattendedSessionRow(
  deps: UnattendedRunDeps,
  run: PreparedUnattendedRun,
  row: { sessionId: SessionID; title: string; extra: Partial<Session> }
): Promise<Partial<Session>> {
  const currentBranch = await deps.branchRepo.findById(run.branch.branch_id);
  if (!currentBranch) {
    throw new EntityNotFoundError('Branch', run.branch.branch_id);
  }
  const sdkHomeAdmission = resolveNewSessionSdkHomeScope({
    branchSdkHomeIntent: currentBranch.sdk_home ?? null,
    enabledForNewSessions: deps.sdkHomeMode === 'per_branch',
  });
  if (sdkHomeAdmission.scope === 'branch' && run.branchSdkHomeIncompatibility) {
    throw new BadRequest(
      `${run.activeTool} cannot use a branch SDK home because ${run.branchSdkHomeIncompatibility}`
    );
  }
  if (sdkHomeAdmission.adoptBranch) {
    await deps.branchRepo.adoptSdkHome(currentBranch.branch_id);
  }
  return {
    session_id: row.sessionId,
    branch_id: run.branch.branch_id,
    agentic_tool: run.activeTool,
    agentic_tool_preset_id: run.sessionConfig.agentic_tool_preset_id ?? undefined,
    status: SessionStatus.IDLE,
    created_by: run.runAsUserId,
    unix_username: run.unixUsername,
    sdk_home_scope: sdkHomeAdmission.scope,
    title: row.title,
    contextFiles: run.config.context_files ?? [],
    permission_config: run.sessionConfig.permission_config,
    model_config: run.sessionConfig.model_config,
    ...row.extra,
  };
}

/**
 * Idempotent: `addServer` ignores an existing attachment. A server deleted
 * since configuration is skipped and reported; other failures escape.
 */
export async function attachUnattendedMcpServers(
  deps: UnattendedRunDeps,
  input: {
    sessionId: SessionID;
    mcpServerIds: readonly string[];
    onMissingServer: (mcpServerId: string) => void;
  }
): Promise<void> {
  for (const serverId of input.mcpServerIds) {
    try {
      await withTenantDatabase(deps, () =>
        deps.sessionMCPRepo.addServer(input.sessionId, serverId as MCPServerID)
      );
    } catch (error) {
      if (!(error instanceof EntityNotFoundError)) throw error;
      input.onMissingServer(serverId);
      continue;
    }
    emitServiceEvent(deps.app, {
      path: 'session-mcp-servers',
      event: 'created',
      data: {
        session_id: input.sessionId,
        mcp_server_id: serverId,
        enabled: true,
        added_at: new Date(),
      },
    });
  }
}

/**
 * Start the first Task through the internal prompt service, as the Session
 * creator, in the current tenant. `idempotencyTaskId` makes a retry return the
 * already-admitted Task. Internal calls skip provider hooks, so a Task not yet
 * admitted rechecks prompt authority and the Manager + Member gate first; a
 * revocation throws `UnattendedRunRevokedError`.
 */
export async function dispatchUnattendedPrompt(
  deps: UnattendedRunDeps,
  input: {
    session: Session;
    creator: User | undefined;
    prompt: string;
    taskId: TaskID;
    taskAlreadyAdmitted: boolean;
  }
): Promise<Task> {
  const { session, creator } = input;
  const tenantId = getCurrentTenantId();
  if (!input.taskAlreadyAdmitted) {
    const authority = await withTenantDatabase(deps, () =>
      deps.branchRepo.resolveSessionPromptAuthority(
        session.branch_id,
        session.created_by as UUID,
        session.created_by as UUID,
        session.sdk_home_scope
      )
    );
    const currentBranch = await withTenantDatabase(deps, () =>
      deps.branchRepo.findById(session.branch_id)
    );
    const creatorAccess = currentBranch
      ? await withTenantDatabase(deps, () =>
          deps.branchRepo.resolveUserAccess(currentBranch, session.created_by as UUID)
        )
      : undefined;
    if (
      !authority.allowed ||
      creatorAccess?.can !== 'all' ||
      !hasMinimumRole(creator?.role, ROLES.MEMBER)
    ) {
      throw new UnattendedRunRevokedError();
    }
  }
  return (await deps.app.service('/sessions/:id/prompt').create(
    {
      prompt: input.prompt,
      permissionMode: session.permission_config?.mode || 'acceptEdits',
      stream: true,
      idempotencyTaskId: input.taskId,
    },
    {
      route: { id: session.session_id },
      provider: undefined,
      ...(creator ? { user: creator } : {}),
      ...(tenantId ? { tenant: { tenant_id: tenantId, source: 'explicit' as const } } : {}),
    } as AuthenticatedParams & { route: { id: string } }
  )) as Task;
}
