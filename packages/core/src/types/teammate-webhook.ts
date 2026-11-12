// src/types/teammate-webhook.ts
import type { BranchID, SessionID, TaskID, UUID } from './id';
import type { PersistedScheduleAgenticToolConfig, ScheduleAgenticToolConfig } from './schedule';

/** Teammate webhook identifier (UUIDv7). */
export type TeammateWebhookID = UUID;

/** One admitted HTTP call to a teammate webhook (UUIDv7). */
export type TeammateWebhookDeliveryID = UUID;

/** Webhook runs take exactly the schedule configuration union (preset, reference, or inline). */
export type TeammateWebhookAgenticToolConfig = ScheduleAgenticToolConfig;

/**
 * An HTTP trigger bound to one teammate branch for life.
 *
 * Never carries the token or its hash: repository projections omit
 * `token_hash`, so no service result, realtime event, or log line can carry it.
 */
export interface TeammateWebhook {
  webhook_id: TeammateWebhookID;
  branch_id: BranchID;
  name: string;
  description?: string;
  /** Trusted Handlebars template, validated by `validateTeammateWebhookPromptTemplate` on write. */
  prompt: string;
  agentic_tool_config: PersistedScheduleAgenticToolConfig;
  mcp_server_ids?: string[];
  enabled: boolean;
  /** false (default): deliveries wait in FIFO order while a run from this webhook is active. */
  allow_concurrent_runs: boolean;
  /** Display-only token prefix. null means no token has been issued, and ingress rejects every call. */
  token_hint: string | null;
  token_issued_at: string | null;
  created_at: string;
  updated_at: string;
  /** Run-as principal. Immutable; set from the authenticated caller on create. */
  created_by: UUID;
}

export interface TeammateWebhookCreateData {
  branch_id: BranchID;
  name: string;
  description?: string;
  prompt: string;
  agentic_tool_config: TeammateWebhookAgenticToolConfig;
  mcp_server_ids?: string[];
  enabled?: boolean;
  allow_concurrent_runs?: boolean;
}

/** Branch reparenting is unsupported. */
export type TeammateWebhookPatchData = Partial<Omit<TeammateWebhookCreateData, 'branch_id'>>;

type ExhaustiveWriteFields<T, Fields extends readonly (keyof T)[]> =
  Exclude<keyof T, Fields[number]> extends never ? Fields : never;

const TEAMMATE_WEBHOOK_PATCH_WRITE_FIELD_VALUES = [
  'name',
  'description',
  'prompt',
  'agentic_tool_config',
  'mcp_server_ids',
  'enabled',
  'allow_concurrent_runs',
] as const;

const TEAMMATE_WEBHOOK_CREATE_WRITE_FIELD_VALUES = [
  'branch_id',
  ...TEAMMATE_WEBHOOK_PATCH_WRITE_FIELD_VALUES,
] as const;

/** Canonical, compile-time-exhaustive allowlist for public webhook creates. */
export const TEAMMATE_WEBHOOK_CREATE_WRITE_FIELDS: ExhaustiveWriteFields<
  TeammateWebhookCreateData,
  typeof TEAMMATE_WEBHOOK_CREATE_WRITE_FIELD_VALUES
> = TEAMMATE_WEBHOOK_CREATE_WRITE_FIELD_VALUES;

/** Canonical, compile-time-exhaustive allowlist for public webhook patches. */
export const TEAMMATE_WEBHOOK_PATCH_WRITE_FIELDS: ExhaustiveWriteFields<
  TeammateWebhookPatchData,
  typeof TEAMMATE_WEBHOOK_PATCH_WRITE_FIELD_VALUES
> = TEAMMATE_WEBHOOK_PATCH_WRITE_FIELD_VALUES;

/** One-time secret issuance result. Only the token route returns it (realtime audience 'none'). */
export interface TeammateWebhookIssuedToken {
  webhook_id: TeammateWebhookID;
  /** Plaintext, shown once. */
  token: string;
  token_hint: string;
  /** null while the public base URL is unknown (hosted mode before the first verified launch). */
  ingress_url: string | null;
}

// ---- Deliveries ----------------------------------------------------------------

export const TEAMMATE_WEBHOOK_DELIVERY_STATUSES = [
  'queued',
  'processing',
  'started',
  'failed',
] as const;
export type TeammateWebhookDeliveryStatus = (typeof TEAMMATE_WEBHOOK_DELIVERY_STATUSES)[number];

/** Permanent failure codes. A closed family, so UI copy can be exhaustive. */
export const TEAMMATE_WEBHOOK_FAILURE_CODES = [
  /** Disabled or deleted after admission. */
  'webhook_disabled',
  'branch_not_teammate',
  /** The creator lost Manager or Member, or prompt authority was denied. */
  'permission_revoked',
  /** The creator was deleted, or delegated mode has no home key. */
  'creator_unavailable',
  'agentic_tool_removed',
  'invalid_config',
  /** Not installed, disabled for the tenant, or unsupported by the deployment. */
  'tool_unavailable',
  'template_render_failed',
  /** The stored payload could not be decrypted or parsed. */
  'payload_unreadable',
  /** The delivery waited longer than `TEAMMATE_WEBHOOK_LIMITS.payloadTtlMs`. */
  'payload_expired',
  'retries_exhausted',
] as const;
export type TeammateWebhookFailureCode = (typeof TEAMMATE_WEBHOOK_FAILURE_CODES)[number];

export function isTeammateWebhookFailureCode(value: unknown): value is TeammateWebhookFailureCode {
  return TEAMMATE_WEBHOOK_FAILURE_CODES.some((code) => code === value);
}

/** Why a queued delivery is not running yet. */
export const TEAMMATE_WEBHOOK_DEFER_REASONS = ['busy', 'transient_retry'] as const;
export type TeammateWebhookDeferReason = (typeof TEAMMATE_WEBHOOK_DEFER_REASONS)[number];

/** Read model. The payload never leaves the repository: not in this type, not in events. */
export type TeammateWebhookDelivery = {
  delivery_id: TeammateWebhookDeliveryID;
  webhook_id: TeammateWebhookID;
  /** Copied from the webhook at admission and immutable, so realtime can use the branch audience. */
  branch_id: BranchID;
  received_at: string;
  idempotency_key: string | null;
  payload_bytes: number;
  attempt_count: number;
  next_attempt_at: string;
} & (
  | {
      status: 'queued';
      defer_reason: TeammateWebhookDeferReason | null;
      session_id: SessionID | null;
    }
  | { status: 'processing'; session_id: SessionID | null }
  | {
      status: 'started';
      /** null only after the session was deleted. */
      session_id: SessionID | null;
      task_id: TaskID | null;
      started_at: string;
    }
  | {
      status: 'failed';
      failure_code: TeammateWebhookFailureCode;
      session_id: SessionID | null;
      failed_at: string;
    }
);

export const TEAMMATE_WEBHOOK_LIMITS = {
  maxBodyBytes: 1_024 * 1_024,
  maxQueuedPerWebhook: 100,
  payloadTtlMs: 72 * 60 * 60_000,
  maxTemplateChars: 20_000,
  maxRenderedPromptBytes: 128 * 1_024,
  maxInterpolatedStringChars: 4_000,
  maxIdempotencyKeyChars: 200,
  terminalRetentionMs: 30 * 24 * 60 * 60_000,
} as const;

// ---- Service paths and protocol identifiers ----------------------------------------

export const TEAMMATE_WEBHOOKS_SERVICE = 'teammate-webhooks';
export const TEAMMATE_WEBHOOK_TOKEN_SERVICE = 'teammate-webhooks/:id/token';
export const TEAMMATE_WEBHOOK_DELIVERIES_SERVICE = 'teammate-webhook-deliveries';
export const TEAMMATE_WEBHOOK_INGRESS_PREFIX = '/webhooks/teammates/';
/** Prefix of every issued token, so leaked tokens are recognizable to secret scanners. */
export const TEAMMATE_WEBHOOK_TOKEN_PREFIX = 'agwh_';
/** Ordered: the first header present wins. */
export const TEAMMATE_WEBHOOK_IDEMPOTENCY_HEADERS = [
  'idempotency-key',
  'x-atlassian-webhook-identifier',
  'x-github-delivery',
] as const;

/** Public ingress URL, or null while the deployment's public base URL is unknown. */
export function teammateWebhookIngressUrl(
  baseUrl: string | null | undefined,
  webhookId: TeammateWebhookID
): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${TEAMMATE_WEBHOOK_INGRESS_PREFIX}${webhookId}/`;
}
