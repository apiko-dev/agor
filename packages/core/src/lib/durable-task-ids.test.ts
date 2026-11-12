import { describe, expect, it } from 'vitest';
import type { GatewayInboundEventID, TeammateWebhookDeliveryID } from '../types';
import {
  gatewayInboundSessionId,
  gatewayInboundTaskId,
  teammateWebhookSessionId,
  teammateWebhookTaskId,
} from './durable-task-ids';

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('teammate webhook durable identities', () => {
  const delivery = '019f0000-0000-7000-8000-0000000000aa' as TeammateWebhookDeliveryID;

  it('derives stable, domain-separated Session and Task ids that keep the UUIDv7 prefix', () => {
    const sessionId = teammateWebhookSessionId(delivery);
    const taskId = teammateWebhookTaskId(delivery);
    expect(teammateWebhookSessionId(delivery)).toBe(sessionId);
    expect(teammateWebhookTaskId(delivery)).toBe(taskId);
    expect(sessionId).toMatch(uuidV7);
    expect(taskId).toMatch(uuidV7);
    expect(sessionId).not.toBe(taskId);
    expect(sessionId.replaceAll('-', '').slice(0, 12)).toBe('019f00000000');
  });

  it('never collides with gateway identities derived from the same source id', () => {
    const sameSource = delivery as unknown as GatewayInboundEventID;
    expect(teammateWebhookSessionId(delivery)).not.toBe(gatewayInboundSessionId(sameSource));
    expect(teammateWebhookTaskId(delivery)).not.toBe(gatewayInboundTaskId(sameSource));
  });

  it('differs per delivery', () => {
    const other = '019f0000-0000-7000-8000-0000000000ab' as TeammateWebhookDeliveryID;
    expect(teammateWebhookSessionId(other)).not.toBe(teammateWebhookSessionId(delivery));
  });
});
