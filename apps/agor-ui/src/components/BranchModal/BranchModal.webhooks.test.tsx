/**
 * The Webhooks tab is teammate-only, and its draft joins the branch editor's
 * unsaved-changes guard like the schedule draft.
 */
import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StandaloneSettingsDrillProvider } from '../SettingsModal/SettingsDrill';
import { BranchModal } from './BranchModal';
import {
  makeBranch,
  makeRepo,
  makeStubClient,
  makeTeammateBranch,
  makeUser,
  renderWithApp,
} from './testUtils';

const webhookSave = vi.hoisted(() => vi.fn());
vi.mock('../TeammateWebhookForm/TeammateWebhookForm', async () => {
  const { useEffect } = await import('react');
  return {
    TeammateWebhookForm: (props: {
      onDraftChange?: (isDirty: (() => boolean) | null) => void;
      onSaveActionChange?: (
        action: { label: string; save: () => void; saving: boolean; disabled: boolean } | null
      ) => void;
    }) => {
      const { onSaveActionChange } = props;
      useEffect(() => {
        onSaveActionChange?.({
          label: 'Create',
          save: webhookSave,
          saving: false,
          disabled: false,
        });
        return () => onSaveActionChange?.(null);
      }, [onSaveActionChange]);
      return (
        <button type="button" onClick={() => props.onDraftChange?.(() => true)}>
          Make webhook dirty
        </button>
      );
    },
  };
});

const withRealtime = (client: AgorClient) =>
  ({
    ...client,
    service: (path: string) => ({ on() {}, off() {}, ...client.service(path) }),
  }) as unknown as AgorClient;

const confirms = () => document.querySelectorAll('.ant-modal-confirm').length;
const owner = makeUser({ user_id: 'user-1', role: 'admin' });

function branchModal(branch: Branch, defaultTab?: 'webhooks') {
  return (
    <BranchModal
      embedded
      open
      onClose={vi.fn()}
      branch={branch}
      repo={makeRepo()}
      sessions={[]}
      client={withRealtime(makeStubClient({ owners: [owner], users: [owner] }).client)}
      currentUser={owner}
      defaultTab={defaultTab}
    />
  );
}

const tabLabels = () =>
  Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim());

describe('BranchModal webhooks', () => {
  it('hides the Webhooks tab for a plain branch', async () => {
    renderWithApp(
      <StandaloneSettingsDrillProvider section="branches">
        {branchModal(makeBranch({ created_by: owner.user_id }))}
      </StandaloneSettingsDrillProvider>
    );
    await screen.findByText('Schedules');
    expect(tabLabels()).not.toContain('Webhooks');
  });

  it('shows Webhooks after Schedules for a teammate', async () => {
    renderWithApp(
      <StandaloneSettingsDrillProvider section="branches">
        {branchModal(makeTeammateBranch({ created_by: owner.user_id }))}
      </StandaloneSettingsDrillProvider>
    );
    await screen.findByText('Webhooks');
    const labels = tabLabels();
    expect(labels.indexOf('Webhooks')).toBe(labels.indexOf('Schedules') + 1);
  });

  it('guards Back in Settings while a webhook draft is unsaved', async () => {
    renderWithApp(
      <StandaloneSettingsDrillProvider section="branches">
        {branchModal(makeTeammateBranch({ created_by: owner.user_id }), 'webhooks')}
      </StandaloneSettingsDrillProvider>
    );
    fireEvent.click((await screen.findAllByRole('button', { name: /New( webhook)?$/ }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Make webhook dirty' }));

    fireEvent.click(screen.getByText('Branches'));
    await waitFor(() => expect(confirms()).toBe(1));
  });

  it('saves an open webhook from the modal footer', async () => {
    webhookSave.mockClear();
    const teammate = makeTeammateBranch({ created_by: owner.user_id });
    renderWithApp(
      <BranchModal
        open
        onClose={vi.fn()}
        branch={teammate}
        repo={makeRepo()}
        sessions={[]}
        client={withRealtime(makeStubClient({ owners: [owner], users: [owner] }).client)}
        currentUser={owner}
        defaultTab="webhooks"
      />
    );
    fireEvent.click((await screen.findAllByRole('button', { name: /New( webhook)?$/ }))[0]);

    // jsdom has no breakpoints, so the standalone editor renders as its bottom sheet.
    const footer = () =>
      document.querySelector('.ant-modal-footer, .ant-drawer-footer') as HTMLElement;
    await waitFor(() =>
      expect(within(footer()).getByRole('button', { name: 'Create' })).toBeEnabled()
    );
    expect(
      within(footer()).queryByRole('button', { name: 'Save changes' })
    ).not.toBeInTheDocument();
    fireEvent.click(within(footer()).getByRole('button', { name: 'Create' }));
    expect(webhookSave).toHaveBeenCalledOnce();
  });

  it('saves an open webhook from the Settings drill-in footer', async () => {
    webhookSave.mockClear();
    renderWithApp(
      <StandaloneSettingsDrillProvider section="branches">
        {branchModal(makeTeammateBranch({ created_by: owner.user_id }), 'webhooks')}
      </StandaloneSettingsDrillProvider>
    );
    fireEvent.click((await screen.findAllByRole('button', { name: /New( webhook)?$/ }))[0]);

    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(webhookSave).toHaveBeenCalledOnce();
  });
});
