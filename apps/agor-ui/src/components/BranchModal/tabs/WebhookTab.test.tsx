import type {
  AgorClient,
  TeammateWebhook,
  TeammateWebhookIssuedToken,
  User,
} from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTeammateBranch, renderWithApp } from '../testUtils';
import { WebhookTab } from './WebhookTab';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));
vi.mock('../../../utils/message', () => ({ useThemedMessage: () => messageMocks }));
vi.mock('../../../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

// The form is covered by its own suite; here it just reports a create.
const created = vi.hoisted(() => ({ webhook: null as TeammateWebhook | null }));
vi.mock('../../TeammateWebhookForm/TeammateWebhookForm', () => ({
  TeammateWebhookForm: (props: {
    onClose: () => void;
    onSaved?: (w: TeammateWebhook, created: boolean) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        if (created.webhook) props.onSaved?.(created.webhook, true);
        props.onClose();
      }}
    >
      Submit webhook form
    </button>
  ),
}));

const BRANCH_ID = 'branch-1';
const WEBHOOK_ID = '00000000-0000-7000-8000-000000000001';
const TOKEN = 'agwh_plaintextsecret';

const makeWebhook = (overrides: Partial<TeammateWebhook> = {}): TeammateWebhook =>
  ({
    webhook_id: WEBHOOK_ID,
    branch_id: BRANCH_ID,
    name: 'Jira triage',
    prompt: 'Triage {{payload.issue.key}}',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: true,
    allow_concurrent_runs: false,
    token_hint: 'agwh_plai',
    token_issued_at: '2026-11-01T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    created_by: 'user-1',
    ...overrides,
  }) as TeammateWebhook;

const issuedFor = (webhookId: string): TeammateWebhookIssuedToken =>
  ({
    webhook_id: webhookId,
    token: TOKEN,
    token_hint: 'agwh_plai',
    ingress_url: `https://agor.example.com/webhooks/teammates/${webhookId}/`,
  }) as TeammateWebhookIssuedToken;

function makeClient(webhooks: TeammateWebhook[], issueToken = vi.fn()) {
  const listeners = new Map<string, (w: TeammateWebhook) => void>();
  const patch = vi.fn(async () => ({}));
  const remove = vi.fn(async () => ({}));
  const client = {
    service(path: string) {
      if (path.endsWith('/token')) return { create: (data: object) => issueToken(path, data) };
      if (path === 'teammate-webhooks') {
        return {
          find: async () => ({ data: webhooks }),
          patch,
          remove,
          on: (event: string, handler: (w: TeammateWebhook) => void) =>
            listeners.set(event, handler),
          off: () => {},
        };
      }
      return { find: async () => ({ data: [] }), on() {}, off() {} };
    },
  } as unknown as AgorClient;
  return { client, listeners, issueToken, patch, remove };
}

function renderTab(
  webhooks: TeammateWebhook[],
  issueToken?: ReturnType<typeof vi.fn>,
  currentUserId = 'user-1'
) {
  const mocks = makeClient(webhooks, issueToken);
  renderWithApp(
    <WebhookTab
      branch={makeTeammateBranch({ branch_id: BRANCH_ID })}
      client={mocks.client}
      currentUser={{ user_id: currentUserId } as User}
    />
  );
  return mocks;
}

describe('WebhookTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    created.webhook = null;
  });

  it('lists webhooks with their token state and follows realtime changes', async () => {
    const { listeners } = renderTab([makeWebhook()]);
    expect(await screen.findByLabelText('Webhook title: Jira triage')).toBeInTheDocument();
    expect(screen.getByText('agwh_plai…')).toBeInTheDocument();

    const other = makeWebhook({
      webhook_id: '00000000-0000-7000-8000-000000000002',
      name: 'GitHub intake',
      token_hint: null,
      token_issued_at: null,
    });
    listeners.get('created')?.(other);
    listeners.get('created')?.(
      makeWebhook({ webhook_id: 'elsewhere', branch_id: 'branch-2', name: 'Elsewhere' })
    );
    expect(await screen.findByLabelText('Webhook title: GitHub intake')).toBeInTheDocument();
    expect(screen.getByText('Not issued')).toBeInTheDocument();
    expect(screen.queryByLabelText('Webhook title: Elsewhere')).not.toBeInTheDocument();

    listeners.get('removed')?.(makeWebhook());
    await waitFor(() =>
      expect(screen.queryByLabelText('Webhook title: Jira triage')).not.toBeInTheDocument()
    );
  });

  it('issues the first token right after create and shows it once', async () => {
    const fresh = makeWebhook({ token_hint: null, token_issued_at: null });
    created.webhook = fresh;
    const issueToken = vi.fn(async (path: string) => issuedFor(path.split('/')[1]));
    renderTab([], issueToken);

    fireEvent.click(await screen.findByRole('button', { name: /New webhook/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit webhook form' }));

    expect(await screen.findByLabelText('Webhook token')).toHaveValue(TOKEN);
    expect(issueToken).toHaveBeenCalledWith(`teammate-webhooks/${WEBHOOK_ID}/token`, {});

    fireEvent.click(screen.getByRole('button', { name: "I've copied it" }));
    await waitFor(() => expect(screen.queryByLabelText('Webhook token')).not.toBeInTheDocument());
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it('offers Issue token when the token call fails after create', async () => {
    created.webhook = makeWebhook({ token_hint: null, token_issued_at: null });
    const issueToken = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(issuedFor(WEBHOOK_ID));
    renderTab([], issueToken);

    fireEvent.click(await screen.findByRole('button', { name: /New webhook/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit webhook form' }));

    expect(await screen.findByText(/was created, but its token wasn't issued/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Issue token' }));
    expect(await screen.findByLabelText('Webhook token')).toHaveValue(TOKEN);
    expect(issueToken).toHaveBeenCalledTimes(2);
  });

  it('rotates a token only after confirmation', async () => {
    const issueToken = vi.fn(async () => issuedFor(WEBHOOK_ID));
    renderTab([makeWebhook()], issueToken);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Rotate token for webhook Jira triage' })
    );
    expect(await screen.findByText('Rotate token?')).toBeInTheDocument();
    expect(issueToken).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(await screen.findByLabelText('Webhook token')).toHaveValue(TOKEN);
    expect(issueToken).toHaveBeenCalledOnce();
  });

  it('turns a webhook off', async () => {
    const { patch } = renderTab([makeWebhook()]);
    fireEvent.click(await screen.findByRole('switch', { name: 'Disable webhook Jira triage' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(WEBHOOK_ID, { enabled: false }));
  });

  it('hides creator-only controls from other users', async () => {
    renderTab([makeWebhook()], undefined, 'user-2');
    const toggle = await screen.findByRole('switch', {
      name: 'Disable webhook Jira triage',
      hidden: true,
    });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Edit webhook Jira triage', hidden: true })
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /token for webhook Jira triage/, hidden: true })
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Delete webhook Jira triage', hidden: true })
    ).toBeTruthy();
  });
});
