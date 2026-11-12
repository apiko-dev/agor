/**
 * Save-time validation shared by every definition that starts unattended runs
 * as its creator (schedules, teammate webhooks). The run-time half lives in
 * `services/unattended-run.ts`.
 */

import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import {
  AgenticConfigurationResolutionError,
  InvalidScheduleAgenticToolConfigError,
  normalizeScheduleAgenticToolConfig,
} from '@agor/core/config';
import { MCPServerRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import { isInvalidModelConfigError } from '@agor/core/models';
import type {
  PersistedScheduleAgenticToolConfig,
  ScheduleAgenticToolConfig,
  UserID,
} from '@agor/core/types';
import {
  materializedAgenticToolConfigurationToScheduleConfig,
  scheduleAgenticToolConfigToSource,
} from './agentic-configuration-sources.js';

export function normalizeUnattendedRunConfig(
  config: PersistedScheduleAgenticToolConfig
): ScheduleAgenticToolConfig {
  try {
    return normalizeScheduleAgenticToolConfig(config);
  } catch (error) {
    if (error instanceof InvalidScheduleAgenticToolConfigError) {
      throw new BadRequest(error.message);
    }
    throw error;
  }
}

/** Materialize against the run-as user so a save fails when that user could not run it. */
export async function validateUnattendedRunConfig(
  db: TenantScopeAwareDatabase,
  config: ScheduleAgenticToolConfig,
  runAsUserId?: UserID
): Promise<PersistedScheduleAgenticToolConfig> {
  try {
    const materialized = await materializeAgenticToolConfiguration(db, {
      tool: config.agentic_tool,
      source: scheduleAgenticToolConfigToSource(config),
      executionOwnerId: runAsUserId,
    });
    return materializedAgenticToolConfigurationToScheduleConfig(config, materialized);
  } catch (error) {
    if (error instanceof AgenticConfigurationResolutionError) {
      throw new BadRequest('Selected agentic configuration is not available');
    }
    if (isInvalidModelConfigError(error)) throw new BadRequest(error.message);
    throw error;
  }
}

/** Runs attach servers as the creator: reject unusable ones on save; missing ones are skipped at run time. */
export async function validateUnattendedRunMcpServers(
  db: TenantScopeAwareDatabase,
  serverIds: string[],
  runAsUserId: UserID | undefined,
  resourcePlural: string
): Promise<void> {
  const repo = new MCPServerRepository(db);
  for (const serverId of serverIds) {
    const server = await repo.getWriteAuthorityProjection(serverId);
    if (server && !isMCPServerUsableBy(server, runAsUserId)) {
      throw new Forbidden(
        `MCP server ${serverId} is private to another user. ${resourcePlural} run as their creator, so only shared servers or servers the creator owns can be attached.`
      );
    }
  }
}
