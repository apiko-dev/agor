/**
 * Public ingress for teammate webhooks: `POST /webhooks/teammates/:webhookId`.
 *
 * Unauthenticated at the transport; the per-webhook bearer token is the only
 * credential. The tenant is discovered from the URL id under a SELECT-only
 * capability, the token is checked against its stored sha256, and the call is
 * admitted durably before 202 is observable. The worker owns every run-time
 * decision (run-as authority, teammate status, rendering).
 *
 * Responses never echo the payload or token. Every rejection after the token
 * is present (unknown id, disabled webhook, no token issued, wrong token) is
 * the same 404 and costs one sha256 compare, so neither the body nor the
 * timing reveals which it was.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  runWithoutTenantContext,
  runWithSystemDatabaseScope,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { isValidUUID } from '@agor/core/ids';
import {
  isTeammate,
  TEAMMATE_WEBHOOK_IDEMPOTENCY_HEADERS,
  TEAMMATE_WEBHOOK_INGRESS_PREFIX,
  TEAMMATE_WEBHOOK_LIMITS,
  type TeammateWebhookID,
} from '@agor/core/types';
import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { structuredLogErrorCode } from '../utils/structured-log.js';

const LOG_PREFIX = '[teammate-webhooks.ingress]';
const NOT_FOUND_BODY = Object.freeze({ error: 'Webhook not found' });
/** Compared against when there is no stored hash, so every path costs one compare. */
const ABSENT_HASH = Buffer.alloc(32);

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function presentedToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  const query = req.query.token;
  return typeof query === 'string' && query ? query : null;
}

function idempotencyKey(req: Request): string | null | 'too_long' {
  for (const name of TEAMMATE_WEBHOOK_IDEMPOTENCY_HEADERS) {
    const value = req.headers[name];
    const key = (Array.isArray(value) ? value[0] : value)?.trim();
    if (!key) continue;
    return key.length > TEAMMATE_WEBHOOK_LIMITS.maxIdempotencyKeyChars ? 'too_long' : key;
  }
  return null;
}

function hasBody(req: Request): boolean {
  const length = Number(req.headers['content-length'] ?? 0);
  return (Number.isFinite(length) && length > 0) || req.headers['transfer-encoding'] !== undefined;
}

function noStoreNoReferrer(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** Body-parser failures on this prefix get fixed bodies; parser messages can quote the payload. */
function ingressParseErrors(error: unknown, _req: Request, res: Response, next: NextFunction) {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.too.large') {
    res.status(413).json({ error: 'Webhook payload exceeds the 1 MiB limit' });
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Webhook payload must be a JSON object or array' });
    return;
  }
  if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
    res.status(415).json({ error: 'Webhook payload must be UTF-8 JSON' });
    return;
  }
  next(error);
}

export function registerTeammateWebhookIngressRoute(input: {
  app: Application;
  db: TenantScopeAwareDatabase;
  /** Defaults to the local worker registered on the app after startup. */
  wakeWorker?: () => void;
}): void {
  const { db } = input;
  const wakeWorker =
    input.wakeWorker ??
    (() => (input.app.get('teammateWebhookWorker') as { wake?: () => void } | undefined)?.wake?.());
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Only rejected requests spend the budget, so a working sender never 429s here.
    skipSuccessfulRequests: true,
    // Senders such as Jira Cloud share egress IPs across customers; one
    // webhook's failures must not spend another webhook's budget.
    keyGenerator: (req) =>
      createHash('sha256')
        .update(JSON.stringify([req.params.webhookId, ipKeyGenerator(req.ip ?? 'unknown')]))
        .digest('hex'),
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many failed webhook calls', code: 'rate_limited' });
    },
  });

  const path = `${TEAMMATE_WEBHOOK_INGRESS_PREFIX}:webhookId`;
  // @ts-expect-error - FeathersJS app extends Express
  input.app.post(path, noStoreNoReferrer, limiter, async (req: Request, res: Response) => {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > TEAMMATE_WEBHOOK_LIMITS.maxBodyBytes) {
      res.status(413).json({ error: 'Webhook payload exceeds the 1 MiB limit' });
      return;
    }
    if (hasBody(req) && !req.is('application/json')) {
      res.status(415).json({ error: 'Webhook payload must be JSON' });
      return;
    }
    const payload: unknown = req.body ?? {};
    if (typeof payload !== 'object' || payload === null) {
      res.status(400).json({ error: 'Webhook payload must be a JSON object or array' });
      return;
    }
    const serialized = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');
    if (payloadBytes > TEAMMATE_WEBHOOK_LIMITS.maxBodyBytes) {
      res.status(413).json({ error: 'Webhook payload exceeds the 1 MiB limit' });
      return;
    }

    const token = presentedToken(req);
    if (!token) {
      res.status(401).json({ error: 'Webhook token required' });
      return;
    }
    const presentedHash = sha256(token);
    const key = idempotencyKey(req);
    if (key === 'too_long') {
      res.status(400).json({ error: 'Idempotency key is too long' });
      return;
    }

    const webhookId = String(req.params.webhookId ?? '') as TeammateWebhookID;
    let tenantId: string | null = null;
    let branchId: string | null = null;
    let storedHash: Buffer = ABSENT_HASH;
    try {
      if (isValidUUID(webhookId)) {
        tenantId = await runWithoutTenantContext(() =>
          runWithSystemDatabaseScope(
            db,
            'teammate webhook ingress discovery',
            (systemDb) =>
              new TeammateWebhookRepository(systemDb).findIngressTenantId(systemDb, webhookId),
            { capability: 'teammate_webhook_ingress_discovery' }
          )
        );
      }
      if (tenantId) {
        // The tenant is the one that owns this enabled webhook row, found under
        // the SELECT-only discovery capability; never a header or body value.
        const credential = await bindRepositoryToTenantUnitOfWork(
          db,
          new TeammateWebhookRepository(db),
          tenantId
        ).findIngressCredential(webhookId);
        if (
          credential?.enabled &&
          credential.token_hash &&
          /^[0-9a-f]{64}$/.test(credential.token_hash)
        ) {
          storedHash = Buffer.from(credential.token_hash, 'hex');
          branchId = credential.branch_id;
        }
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} event=lookup_failed code=${structuredLogErrorCode(error)}`);
      res.status(503).json({ error: 'Webhook delivery was not durably admitted' });
      return;
    }
    const matches = timingSafeEqual(presentedHash, storedHash) && storedHash !== ABSENT_HASH;
    if (!tenantId || !branchId || !matches) {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }
    // Only a caller holding the valid token reaches this read, so its extra
    // cost reveals nothing the token did not already prove.
    try {
      const branch = await bindRepositoryToTenantUnitOfWork(
        db,
        new BranchRepository(db),
        tenantId
      ).findById(branchId);
      if (!branch || !isTeammate(branch)) {
        res.status(404).json(NOT_FOUND_BODY);
        return;
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} event=lookup_failed code=${structuredLogErrorCode(error)}`);
      res.status(503).json({ error: 'Webhook delivery was not durably admitted' });
      return;
    }

    let outcome: Awaited<ReturnType<TeammateWebhookDeliveryRepository['admit']>>;
    try {
      outcome = await bindRepositoryToTenantUnitOfWork(
        db,
        new TeammateWebhookDeliveryRepository(db),
        tenantId
      ).admit({ webhookId, idempotencyKey: key, payload, payloadBytes });
    } catch (error) {
      console.error(`${LOG_PREFIX} event=admission_failed code=${structuredLogErrorCode(error)}`);
      res.status(503).json({ error: 'Webhook delivery was not durably admitted' });
      return;
    }
    if (outcome.outcome === 'rejected') {
      if (outcome.reason === 'queue_full') {
        res.status(429).json({ error: 'Webhook delivery queue is full', code: 'queue_full' });
      } else {
        res.status(404).json(NOT_FOUND_BODY);
      }
      return;
    }
    res.status(202).json({
      delivery_id: outcome.delivery.delivery_id,
      status: outcome.delivery.status,
      duplicate: outcome.outcome === 'duplicate',
    });
    if (outcome.outcome === 'admitted') {
      try {
        wakeWorker();
      } catch {
        // Polling remains the cross-replica fallback.
      }
    }
  });
  // @ts-expect-error - FeathersJS app extends Express
  input.app.use(TEAMMATE_WEBHOOK_INGRESS_PREFIX, ingressParseErrors);
}
