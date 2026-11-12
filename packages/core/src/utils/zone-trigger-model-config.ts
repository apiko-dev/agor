/**
 * Write-time shape check for a zone trigger's `model_config`.
 *
 * Zone triggers are authored by board editors, MCP callers and imports, and
 * the stored selection later becomes an explicit session config for whoever
 * drops a branch, so it must hold a bounded model id and a known effort.
 * Whether the model exists for the tool is checked at session creation.
 */

import type { ZoneTriggerModelConfig } from '../types/board';
import type { EffortLevel } from '../types/session';

const EFFORT_LEVELS: Record<EffortLevel, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
const MODES: Record<NonNullable<ZoneTriggerModelConfig['mode']>, true> = {
  alias: true,
  exact: true,
};
const ALLOWED_KEYS = new Set<string>(['mode', 'model', 'effort']);
export const ZONE_TRIGGER_MODEL_MAX_LENGTH = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelConfigError(value: unknown): string | null {
  const config = asRecord(value);
  if (!config) return 'trigger.model_config must be an object';
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) return `trigger.model_config.${key} is not supported`;
  }
  const { mode, model, effort } = config;
  if (mode !== undefined && !(typeof mode === 'string' && Object.hasOwn(MODES, mode))) {
    return 'trigger.model_config.mode must be "alias" or "exact"';
  }
  if (
    model !== undefined &&
    !(
      typeof model === 'string' &&
      model.trim() === model &&
      model.length > 0 &&
      model.length <= ZONE_TRIGGER_MODEL_MAX_LENGTH
    )
  ) {
    return `trigger.model_config.model must be a non-empty model id of at most ${ZONE_TRIGGER_MODEL_MAX_LENGTH} characters`;
  }
  if (
    effort !== undefined &&
    !(typeof effort === 'string' && Object.hasOwn(EFFORT_LEVELS, effort))
  ) {
    return 'trigger.model_config.effort must be one of low, medium, high, xhigh, max';
  }
  if (model === undefined && effort === undefined) {
    return 'trigger.model_config must set a model or an effort';
  }
  return null;
}

/**
 * Why a board object's zone trigger `model_config` is unusable, or null when it
 * is fine or absent. A value equal to the one in `previous` is not rechecked.
 */
export function zoneTriggerModelConfigError(object: unknown, previous?: unknown): string | null {
  const next = asRecord(asRecord(object)?.trigger)?.model_config;
  if (next === undefined) return null;
  const stored = asRecord(asRecord(previous)?.trigger)?.model_config;
  if (stored !== undefined && JSON.stringify(stored) === JSON.stringify(next)) return null;
  return modelConfigError(next);
}
