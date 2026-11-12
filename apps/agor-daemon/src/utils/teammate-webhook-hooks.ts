/**
 * RBAC hooks for the teammate webhook services. A webhook inherits its access
 * from its branch: reads need view, writes need Manager ('all'), and only the
 * creator, who is the run-as principal, may edit it or mint its token.
 */

import type {
  BranchRepository,
  TeammateWebhookDeliveryRepository,
  TeammateWebhookRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  HookContext,
  RBACParams,
  TeammateWebhook,
  TeammateWebhookDeliveryID,
  TeammateWebhookID,
  UUID,
} from '@agor/core/types';
import { cacheBranchAccess, isSuperAdmin, paginateClientSide } from './branch-authorization.js';

type WebhookParams = RBACParams & { teammateWebhook?: TeammateWebhook };

function isExternalUserCall(context: HookContext): boolean {
  return Boolean(context.params.provider) && !context.params.user?._isServiceAccount;
}

/** Scope find to webhooks whose branch the caller can view. */
export function scopeTeammateWebhookQuery(
  webhookRepo: TeammateWebhookRepository,
  options?: { allowSuperadmin?: boolean }
) {
  return async (context: HookContext) => {
    if (!isExternalUserCall(context) || context.method !== 'find') return context;
    const userId = context.params.user?.user_id as UUID | undefined;
    if (!userId) {
      context.result = { total: 0, limit: 0, skip: 0, data: [] };
      return context;
    }
    const q = (context.params.query ?? {}) as Record<string, unknown>;
    const filter = {
      branch_id:
        typeof q.branch_id === 'string' ? (q.branch_id as TeammateWebhook['branch_id']) : undefined,
      enabled:
        q.enabled === true || q.enabled === 'true'
          ? true
          : q.enabled === false || q.enabled === 'false'
            ? false
            : undefined,
    };
    const rows = isSuperAdmin(context.params.user?.role, options?.allowSuperadmin ?? true)
      ? await webhookRepo.findAll(filter)
      : await webhookRepo.findAccessible(userId, filter);
    context.result = paginateClientSide(rows, q, new Set(['branch_id', 'enabled']));
    return context;
  };
}

/** Load the webhook named by `context.id` or `route.id`, then cache its branch access. */
export function loadTeammateWebhookAndBranch(
  webhookRepo: TeammateWebhookRepository,
  branchRepo: BranchRepository
) {
  return async (context: HookContext) => {
    if (!isExternalUserCall(context)) return context;
    const id = context.id ?? context.params.route?.id;
    if (!id) throw new BadRequest('Webhook ID required');
    const webhook = await webhookRepo.findById(String(id));
    if (!webhook) throw new NotFound(`Teammate webhook not found: ${id}`);
    const branch = await branchRepo.findById(webhook.branch_id);
    if (!branch) throw new NotFound(`Branch not found for teammate webhook: ${webhook.webhook_id}`);
    (context.params as WebhookParams).teammateWebhook = webhook;
    await cacheBranchAccess(context.params, branchRepo, branch);
    return context;
  };
}

/**
 * Deliveries are read through their webhook: find needs `webhook_id`, get loads
 * the delivery's webhook. Both then cache the branch for `ensureCanView`.
 */
export function loadTeammateWebhookDeliveryScope(
  webhookRepo: TeammateWebhookRepository,
  deliveryRepo: TeammateWebhookDeliveryRepository,
  branchRepo: BranchRepository
) {
  return async (context: HookContext) => {
    if (!isExternalUserCall(context)) return context;
    let webhookId: string | undefined;
    if (context.method === 'find') {
      const q = (context.params.query ?? {}) as Record<string, unknown>;
      if (typeof q.webhook_id !== 'string' || !q.webhook_id) {
        throw new BadRequest('webhook_id is required');
      }
      webhookId = q.webhook_id;
    } else {
      const delivery = context.id
        ? await deliveryRepo.findById(String(context.id) as TeammateWebhookDeliveryID)
        : null;
      if (!delivery) throw new NotFound(`Webhook delivery not found: ${context.id}`);
      webhookId = delivery.webhook_id;
    }
    const webhook = await webhookRepo.findById(webhookId as TeammateWebhookID);
    if (!webhook) throw new NotFound(`Teammate webhook not found: ${webhookId}`);
    const branch = await branchRepo.findById(webhook.branch_id);
    if (!branch) throw new NotFound(`Branch not found for teammate webhook: ${webhook.webhook_id}`);
    if (context.method === 'find') {
      // Pin the query to the resolved full id so a short-id prefix cannot widen it.
      (context.params.query as Record<string, unknown>).webhook_id = webhook.webhook_id;
    }
    (context.params as WebhookParams).teammateWebhook = webhook;
    await cacheBranchAccess(context.params, branchRepo, branch);
    return context;
  };
}

/**
 * The creator is the run-as principal: only they may edit the webhook or mint
 * the credential that starts runs as them. No superadmin bypass.
 */
export function ensureTeammateWebhookRunsAsCaller() {
  return (context: HookContext): HookContext => {
    if (!isExternalUserCall(context)) return context;
    const user = context.params.user;
    if (!user?.user_id) throw new NotAuthenticated('Authentication required');
    const webhook = (context.params as WebhookParams).teammateWebhook;
    if (!webhook) throw new Error('ensureTeammateWebhookRunsAsCaller requires a loaded webhook');
    if (webhook.created_by !== user.user_id) {
      throw new Forbidden(
        'Teammate webhooks run as the user who created them. You can only modify webhooks you created.'
      );
    }
    return context;
  };
}
