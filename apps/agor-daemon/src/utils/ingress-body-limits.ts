/**
 * Tighter body bounds for unauthenticated provider ingress than the general
 * API's 10 MB. Used as the body parsers' `verify` callback, so an oversized
 * body is rejected while parsing and never materialized into `req.body`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { TEAMMATE_WEBHOOK_INGRESS_PREFIX, TEAMMATE_WEBHOOK_LIMITS } from '@agor/core/types';

const INGRESS_BODY_LIMITS: ReadonlyArray<{ prefix: string; maxBytes: number; message: string }> = [
  {
    prefix: '/gateway/teams/',
    maxBytes: 1_024 * 1_024,
    message: 'Teams activity exceeds the 1 MiB limit',
  },
  {
    prefix: TEAMMATE_WEBHOOK_INGRESS_PREFIX,
    maxBytes: TEAMMATE_WEBHOOK_LIMITS.maxBodyBytes,
    message: 'Webhook payload exceeds the 1 MiB limit',
  },
];

export function verifyIngressBodyLimit(
  req: IncomingMessage,
  _res: ServerResponse,
  buffer: Buffer
): void {
  const url = (req.url ?? '').toLowerCase();
  const limit = INGRESS_BODY_LIMITS.find((entry) => url.startsWith(entry.prefix));
  if (!limit || buffer.byteLength <= limit.maxBytes) return;
  const error = new Error(limit.message) as Error & { status?: number; type?: string };
  error.status = 413;
  error.type = 'entity.too.large';
  throw error;
}
