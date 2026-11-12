import type {
  AgorClient,
  TeammateWebhook,
  TeammateWebhookDelivery,
  TeammateWebhookFailureCode,
} from '@agor-live/client';
import { TEAMMATE_WEBHOOK_FAILURE_CODES } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  describeFailureCode,
  TeammateWebhookDeliveriesPanel,
} from './TeammateWebhookDeliveriesPanel';

const WEBHOOK_ID = '00000000-0000-7000-8000-000000000001';
const SESSION_ID = '00000000-0000-7000-8000-0000000000aa';

const webhook = {
  webhook_id: WEBHOOK_ID,
  branch_id: 'branch-1',
  name: 'Jira triage',
} as TeammateWebhook;

const base = {
  webhook_id: WEBHOOK_ID,
  branch_id: 'branch-1',
  received_at: '2026-11-01T10:00:00.000Z',
  idempotency_key: null,
  payload_bytes: 10,
  attempt_count: 0,
  next_attempt_at: '2026-11-01T10:00:00.000Z',
};

const delivery = (id: string, rest: object) =>
  ({ ...base, delivery_id: id, ...rest }) as TeammateWebhookDelivery;

function renderPanel(deliveries: TeammateWebhookDelivery[]) {
  const listeners = new Map<string, (d: TeammateWebhookDelivery) => void>();
  const find = vi.fn(async () => ({ data: deliveries }));
  const client = {
    service: () => ({
      find,
      on: (event: string, handler: (d: TeammateWebhookDelivery) => void) =>
        listeners.set(event, handler),
      off: () => {},
    }),
  } as unknown as AgorClient;
  const onOpenSession = vi.fn();
  render(
    <AntApp>
      <TeammateWebhookDeliveriesPanel
        open
        onClose={() => {}}
        webhook={webhook}
        client={client}
        onOpenSession={onOpenSession}
      />
    </AntApp>
  );
  return { find, listeners, onOpenSession };
}

describe('TeammateWebhookDeliveriesPanel', () => {
  it('loads the newest deliveries for the webhook', async () => {
    const { find } = renderPanel([]);
    expect(await screen.findByText('No calls yet.')).toBeInTheDocument();
    expect(find).toHaveBeenCalledWith({
      query: { webhook_id: WEBHOOK_ID, $limit: 20, $sort: { received_at: -1 } },
    });
  });

  it('explains waiting, started, and failed deliveries and links their sessions', async () => {
    const { onOpenSession } = renderPanel([
      delivery('d1', { status: 'queued', defer_reason: 'busy', session_id: null }),
      delivery('d2', {
        status: 'started',
        session_id: SESSION_ID,
        task_id: null,
        started_at: base.received_at,
      }),
      delivery('d3', {
        status: 'failed',
        failure_code: 'permission_revoked',
        session_id: null,
        failed_at: base.received_at,
      }),
    ]);

    expect(await screen.findByText('Waiting for the previous run')).toBeInTheDocument();
    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(
      screen.getByText("The webhook's creator no longer has permission to run this teammate.")
    ).toBeInTheDocument();

    const open = screen.getAllByRole('button', { name: /Open session/ });
    expect(open).toHaveLength(1);
    fireEvent.click(open[0]);
    expect(onOpenSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('shows a delivery that arrives while open', async () => {
    const { listeners } = renderPanel([]);
    await screen.findByText('No calls yet.');
    listeners.get('created')?.(delivery('d9', { status: 'processing', session_id: null }));
    expect(await screen.findByText('Starting')).toBeInTheDocument();
  });

  it('has distinct copy for every failure code', () => {
    const copy = TEAMMATE_WEBHOOK_FAILURE_CODES.map((code: TeammateWebhookFailureCode) =>
      describeFailureCode(code)
    );
    expect(copy.every((text) => text.length > 0 && !text.includes('_'))).toBe(true);
    expect(new Set(copy).size).toBe(TEAMMATE_WEBHOOK_FAILURE_CODES.length);
  });
});
