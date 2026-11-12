import type { TeammateWebhookIssuedToken } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssuedTokenPanel } from './IssuedTokenPanel';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => messageMocks }));
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock('../../utils/clipboard', () => clipboard);

const WEBHOOK_ID = '00000000-0000-7000-8000-000000000001';
const TOKEN = 'agwh_secretsecretsecret';

const issued = (ingress_url: string | null): TeammateWebhookIssuedToken =>
  ({
    webhook_id: WEBHOOK_ID,
    token: TOKEN,
    token_hint: 'agwh_secr',
    ingress_url,
  }) as TeammateWebhookIssuedToken;

function renderPanel(token: TeammateWebhookIssuedToken) {
  const onDone = vi.fn();
  render(
    <AntApp>
      <IssuedTokenPanel issued={token} webhookName="Jira triage" onDone={onDone} />
    </AntApp>
  );
  return { onDone };
}

describe('IssuedTokenPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the URL, the token, and a bearer curl example', async () => {
    const url = `https://agor.example.com/webhooks/teammates/${WEBHOOK_ID}/`;
    const { onDone } = renderPanel(issued(url));

    expect(screen.getByText('Copy this token now')).toBeInTheDocument();
    expect(screen.getByText(url)).toBeInTheDocument();
    expect(screen.getByLabelText('Webhook token')).toHaveValue(TOKEN);
    expect(screen.getByText(/Authorization: Bearer agwh_secretsecretsecret/)).toBeInTheDocument();
    expect(screen.getByText('?token=<token>')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Copy token/ }));
    await waitFor(() => expect(clipboard.copyToClipboard).toHaveBeenCalledWith(TOKEN));
    expect(messageMocks.showSuccess).toHaveBeenCalledWith('Token copied.');

    fireEvent.click(screen.getByRole('button', { name: "I've copied it" }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('explains a URL that is not known yet', () => {
    renderPanel(issued(null));
    expect(screen.getByText("The public URL isn't known yet")).toBeInTheDocument();
    expect(screen.getByText(`/webhooks/teammates/${WEBHOOK_ID}/`)).toBeInTheDocument();
    expect(screen.getByLabelText('Webhook token')).toHaveValue(TOKEN);
  });
});
