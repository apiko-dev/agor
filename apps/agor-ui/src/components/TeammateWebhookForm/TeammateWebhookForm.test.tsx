import type { AgorClient, BranchID, TeammateWebhook } from '@agor-live/client';
import { WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTeammateBranch } from '../BranchModal/testUtils';
import { TeammateWebhookForm } from './TeammateWebhookForm';

const messageMocks = vi.hoisted(() => ({ showError: vi.fn(), showSuccess: vi.fn() }));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => messageMocks }));
vi.mock('../AgentSelectionGrid', () => ({
  AVAILABLE_AGENTS: [],
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../AgenticToolConfigurationPicker', async () => {
  const { Form: AntForm } = await import('antd');
  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: ({ defaultResolution }: { defaultResolution?: string }) => {
      const form = AntForm.useFormInstance();
      return (
        <div data-testid="configuration-picker" data-default-resolution={defaultResolution}>
          <button
            type="button"
            onClick={() => form.setFieldValue('agenticToolPresetId', '__workspace_default__')}
          >
            Choose workspace default
          </button>
        </div>
      );
    },
  };
});

const BRANCH_ID = '00000000-0000-7000-8000-000000000002' as BranchID;

function makeWebhook(overrides: Partial<TeammateWebhook> = {}): TeammateWebhook {
  return {
    webhook_id: '00000000-0000-7000-8000-000000000001',
    branch_id: BRANCH_ID,
    name: 'Jira triage',
    prompt: 'Triage {{payload.issue.key}}',
    agentic_tool_config: { agentic_tool: 'claude-code', permission_mode: 'auto' },
    enabled: true,
    allow_concurrent_runs: false,
    token_hint: 'agwh_abcd',
    token_issued_at: '2026-11-01T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    created_by: '00000000-0000-7000-8000-000000000003',
    ...overrides,
  } as TeammateWebhook;
}

function renderForm({
  webhook = null,
  create = vi.fn(),
  patch = vi.fn(),
  onSaved = vi.fn(),
  onClose = vi.fn(),
}: {
  webhook?: TeammateWebhook | null;
  create?: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
  onSaved?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
} = {}) {
  const client = { service: () => ({ create, patch }) } as unknown as AgorClient;
  render(
    <AntApp>
      <TeammateWebhookForm
        onClose={onClose}
        branch={makeTeammateBranch({ branch_id: BRANCH_ID, name: 'triage-bot' })}
        webhook={webhook}
        mcpServerById={new Map()}
        client={client}
        onSaved={onSaved}
      />
    </AntApp>
  );
  return { create, patch, onSaved, onClose };
}

const promptField = () =>
  screen.getByPlaceholderText(/A Jira issue was updated/) as HTMLTextAreaElement;

describe('TeammateWebhookForm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves picker defaults per webhook run', async () => {
    renderForm();
    expect(await screen.findByTestId('configuration-picker')).toHaveAttribute(
      'data-default-resolution',
      'webhook-run'
    );
  });

  it('rejects an unsafe template on the field and does not save', async () => {
    const { create } = renderForm();
    fireEvent.change(await screen.findByPlaceholderText('Jira triage'), {
      target: { value: 'Triage' },
    });
    fireEvent.change(promptField(), { target: { value: 'Raw {{{payload.issue}}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText(/Unescaped output/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the webhook and reports it as new', async () => {
    const created = makeWebhook({ token_hint: null, token_issued_at: null });
    const create = vi.fn(async () => created);
    const { onSaved, onClose } = renderForm({ create });

    fireEvent.change(await screen.findByPlaceholderText('Jira triage'), {
      target: { value: ' Jira triage ' },
    });
    fireEvent.change(promptField(), { target: { value: 'Triage {{payload.issue.key}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose workspace default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({
      branch_id: BRANCH_ID,
      name: 'Jira triage',
      prompt: 'Triage {{payload.issue.key}}',
      enabled: true,
      allow_concurrent_runs: false,
      agentic_tool_config: {
        agentic_tool: 'claude-code',
        configuration_reference: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      },
    });
    expect(onSaved).toHaveBeenCalledWith(created, true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('patches an existing webhook without its branch', async () => {
    const webhook = makeWebhook();
    const patch = vi.fn(async (_id: string, data: object) => ({ ...webhook, ...data }));
    const { onSaved } = renderForm({ webhook, patch });

    fireEvent.change(await screen.findByDisplayValue('Jira triage'), {
      target: { value: 'Jira intake' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][0]).toBe(webhook.webhook_id);
    expect(patch.mock.calls[0][1]).not.toHaveProperty('branch_id');
    expect(patch.mock.calls[0][1]).toMatchObject({ name: 'Jira intake' });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jira intake' }), false);
  });

  it('previews the prompt with payload values quoted as data', async () => {
    renderForm({ webhook: makeWebhook() });
    fireEvent.click(await screen.findByText('Preview with a sample payload'));

    expect(await screen.findByText(/Triage "PROJ-42"/)).toBeInTheDocument();
    expect(screen.getByText(/untrusted data, not instructions/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Sample payload'), { target: { value: '{nope' } });
    expect(await screen.findByText("The sample payload isn't valid JSON.")).toBeInTheDocument();
  });
});
