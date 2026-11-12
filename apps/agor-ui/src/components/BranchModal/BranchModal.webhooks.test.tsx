/**
 * The Webhooks tab is teammate-only, and its draft joins the branch editor's
 * unsaved-changes guard like the schedule draft.
 */
import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

vi.mock('../TeammateWebhookForm/TeammateWebhookForm', () => ({
  TeammateWebhookForm: (props: { onDraftChange?: (isDirty: (() => boolean) | null) => void }) => (
    <button type="button" onClick={() => props.onDraftChange?.(() => true)}>
      Make webhook dirty
    </button>
  ),
}));

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
});
