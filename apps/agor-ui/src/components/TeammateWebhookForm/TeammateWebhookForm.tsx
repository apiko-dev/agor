/**
 * Teammate webhook create / edit form. The teammate's Webhooks tab renders it
 * in place of the webhook list, mirroring ScheduleForm.
 */

import type {
  AgenticToolName,
  AgorClient,
  Branch,
  DirectoryUser,
  MCPServer,
  TeammateWebhook,
  TeammateWebhookCreateData,
  TeammateWebhookPatchData,
  User,
} from '@agor-live/client';
import { isActiveScheduleAgenticToolConfig, TEAMMATE_WEBHOOKS_SERVICE } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Collapse,
  Form,
  Input,
  Radio,
  Space,
  Switch,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ActionErrorCopy,
  describeActionError,
  isInFlightConnectionLossError,
  notConnectedMessage,
} from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';
import { getFormValuesFromConfig, scheduleConfigToDefaultConfig } from '../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../AgenticToolConfigurationPicker';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { ActionErrorNotice } from '../CompactNotice';
import { ExpandableAlert } from '../ExpandableAlert';
import {
  type AutomationAgenticFormValues,
  buildAutomationAgenticToolConfig,
} from '../ScheduleForm/automationAgenticConfig';
import { DrillCrumbs, useDiscardConfirm, useDrillFormDraft } from '../SettingsModal/SettingsDrill';

const { TextArea } = Input;
const { Text } = Typography;

/** Loaded on demand: the template engine is only needed while this form is open. */
const loadPromptTemplates = () => import('@agor/core/templates/teammate-webhook-prompt');
type PromptTemplates = Awaited<ReturnType<typeof loadPromptTemplates>>;

/** Stands in for the id a new webhook gets on create. */
const PREVIEW_WEBHOOK_ID = '00000000-0000-7000-8000-000000000000' as TeammateWebhook['webhook_id'];

const SAMPLE_PAYLOAD = JSON.stringify(
  {
    webhookEvent: 'jira:issue_updated',
    issue: { key: 'PROJ-42', fields: { summary: 'Login page returns 500' } },
    user: { displayName: 'Ada Lovelace' },
  },
  null,
  2
);

export interface TeammateWebhookFormProps {
  /** Leaves the form: after Cancel (once a dirty draft is confirmed) or a save. */
  onClose: () => void;
  /** The teammate branch the webhook belongs to. */
  branch: Branch;
  /** Existing webhook when editing; null/undefined when creating. */
  webhook?: TeammateWebhook | null;
  mcpServerById: Map<string, MCPServer>;
  client: AgorClient | null;
  /** Stable owner whose defaults resolve at each run. */
  executionOwner?: DirectoryUser | null;
  /** Authenticated caller; model catalogs are caller-scoped. */
  currentUser?: User | null;
  /** Fires after a successful save. `created` is true for a new webhook. */
  onSaved?: (webhook: TeammateWebhook, created: boolean) => void;
  /** Hands up the draft's dirty getter while open (null on unmount) for an outer leave guard. */
  onDraftChange?: (isDirty: (() => boolean) | null) => void;
}

interface WebhookFormValues extends AutomationAgenticFormValues {
  mcpServerIds?: string[];
  name?: string;
  description?: string;
  prompt?: string;
  agenticTool?: AgenticToolName;
  enabled?: boolean;
  allow_concurrent_runs?: boolean;
}

const TemplateHelp: React.FC = () => {
  const { token } = theme.useToken();
  return (
    <ExpandableAlert
      title="Handlebars template support"
      summary="Reference the webhook payload and teammate with {{ ... }} syntax."
      style={{ marginTop: token.marginXS }}
    >
      <ul style={{ marginLeft: token.margin, marginBottom: token.marginXS }}>
        <li>
          <code>{'{{payload.*}}'}</code> — the JSON body of the call, e.g.{' '}
          <code>{'{{payload.issue.key}}'}</code>
        </li>
        <li>
          <code>{'{{webhook.name}}'}</code> <code>{'{{webhook.webhook_id}}'}</code>
        </li>
        <li>
          <code>{'{{branch.name}}'}</code> <code>{'{{branch.ref}}'}</code>{' '}
          <code>{'{{branch.issue_url}}'}</code> <code>{'{{branch.pull_request_url}}'}</code>
        </li>
        <li>
          <code>{'{{delivery.delivery_id}}'}</code> <code>{'{{delivery.received_at}}'}</code>
        </li>
        <li>
          Helpers: <code>json</code> <code>default</code> <code>eq</code> <code>ne</code>{' '}
          <code>and</code> <code>or</code> <code>not</code>. Blocks: <code>#if</code>{' '}
          <code>#unless</code> <code>#each</code> <code>#with</code>.
        </li>
      </ul>
      <p style={{ marginBottom: token.marginXS }}>
        Payload values come from outside Agor. Each one is inserted as a quoted, escaped JSON value
        (<code>"PROJ-42"</code>, not <code>PROJ-42</code>), and the prompt tells the agent to treat
        them as data, not instructions. Use <code>{'{{json payload.issue}}'}</code> to insert a
        whole object.
      </p>
      <p style={{ marginBottom: 0 }}>
        Example: <code>{'Triage {{payload.issue.key}}: {{payload.issue.fields.summary}}'}</code>
      </p>
    </ExpandableAlert>
  );
};

const PromptPreview: React.FC<{
  templates: PromptTemplates | null;
  template: string;
  webhookName: string;
  webhookId: TeammateWebhook['webhook_id'];
  branch: Branch;
}> = ({ templates, template, webhookName, webhookId, branch }) => {
  const { token } = theme.useToken();
  const [samplePayload, setSamplePayload] = useState(SAMPLE_PAYLOAD);
  const [receivedAt] = useState(() => new Date().toISOString());

  const preview = useMemo((): { ok: true; text: string } | { ok: false; message: string } => {
    if (!templates) return { ok: false, message: 'Loading preview…' };
    if (!template.trim()) return { ok: false, message: 'Write a prompt template to preview it.' };
    const validation = templates.validateTeammateWebhookPromptTemplate(template);
    if (!validation.ok) return validation;
    let payload: unknown;
    try {
      payload = JSON.parse(samplePayload);
    } catch {
      return { ok: false, message: "The sample payload isn't valid JSON." };
    }
    try {
      return {
        ok: true,
        text: templates.renderTeammateWebhookPrompt({
          template,
          webhook: { webhook_id: webhookId, name: webhookName },
          branch,
          delivery: { delivery_id: 'sample-delivery', received_at: receivedAt },
          payload,
        }),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, [templates, template, samplePayload, webhookName, webhookId, branch, receivedAt]);

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Text type="secondary">Sample payload (JSON)</Text>
      <TextArea
        aria-label="Sample payload"
        value={samplePayload}
        onChange={(e) => setSamplePayload(e.target.value)}
        autoSize={{ minRows: 4, maxRows: 12 }}
        style={{ fontFamily: token.fontFamilyCode }}
      />
      <Text type="secondary">What the agent receives</Text>
      {preview.ok ? (
        <pre
          style={{
            margin: 0,
            padding: token.paddingSM,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: token.fontFamilyCode,
            fontSize: token.fontSizeSM,
            background: token.colorFillTertiary,
            borderRadius: token.borderRadius,
          }}
        >
          {preview.text}
        </pre>
      ) : (
        <Text type="secondary">{preview.message}</Text>
      )}
    </Space>
  );
};

export const TeammateWebhookForm: React.FC<TeammateWebhookFormProps> = ({
  onClose,
  branch,
  webhook,
  mcpServerById,
  client,
  executionOwner,
  currentUser,
  onSaved,
  onDraftChange,
}) => {
  const isEditing = Boolean(webhook?.webhook_id);
  const { showSuccess } = useThemedMessage();
  const [form] = Form.useForm<WebhookFormValues>();
  const [templates, setTemplates] = useState<PromptTemplates | null>(null);

  const configuredConfig = webhook?.agentic_tool_config;
  const configuredActiveTool = isActiveScheduleAgenticToolConfig(configuredConfig)
    ? configuredConfig.agentic_tool
    : undefined;
  const [agentTool, setAgentTool] = useState<AgenticToolName>(
    configuredActiveTool ?? 'claude-code'
  );
  const [requiresSupportedToolSelection, setRequiresSupportedToolSelection] = useState(
    Boolean(configuredConfig?.agentic_tool && !configuredActiveTool)
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ActionErrorCopy | null>(null);
  // A create whose reply was lost may have landed; block a second click until the form changes.
  const [createUnconfirmed, setCreateUnconfirmed] = useState(false);
  const saveErrorRef = useRef<HTMLDivElement>(null);
  const executionOwnerResolved =
    !webhook?.created_by || executionOwner?.user_id === webhook.created_by;

  useEffect(() => {
    let live = true;
    void loadPromptTemplates().then((module) => {
      if (live) setTemplates(module);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const persistedConfig = webhook?.agentic_tool_config;
    const activeConfig = isActiveScheduleAgenticToolConfig(persistedConfig)
      ? persistedConfig
      : undefined;
    const tool = activeConfig?.agentic_tool ?? 'claude-code';
    setAgentTool(tool);
    setRequiresSupportedToolSelection(Boolean(persistedConfig?.agentic_tool && !activeConfig));
    setSaveError(null);
    setCreateUnconfirmed(false);
    form.resetFields();
    form.setFieldsValue({
      name: webhook?.name ?? '',
      description: webhook?.description ?? '',
      prompt: webhook?.prompt ?? '',
      agenticTool: tool,
      agenticToolPresetId:
        persistedConfig?.configuration_reference ??
        persistedConfig?.preset_id ??
        INLINE_AGENTIC_CONFIGURATION,
      enabled: webhook?.enabled ?? true,
      allow_concurrent_runs: webhook?.allow_concurrent_runs ?? false,
      ...getFormValuesFromConfig(tool, scheduleConfigToDefaultConfig(activeConfig)),
      mcpServerIds: webhook?.mcp_server_ids ?? [],
    });
  }, [webhook, form]);

  const isDraftDirty = useDrillFormDraft(form, webhook ?? 'new');
  const confirmDiscard = useDiscardConfirm();
  const leave = () => confirmDiscard(isDraftDirty(), onClose);
  useEffect(() => {
    onDraftChange?.(isDraftDirty);
    return () => onDraftChange?.(null);
  }, [isDraftDirty, onDraftChange]);

  useEffect(() => {
    if (saveError) saveErrorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [saveError]);

  // Reseed config fields only when the user changes the agent, never on open.
  const handleAgentToolChange = (next: AgenticToolName) => {
    if (next === agentTool && !requiresSupportedToolSelection) return;
    setCreateUnconfirmed(false);
    setRequiresSupportedToolSelection(false);
    setAgentTool(next);
    form.setFieldsValue({
      ...getFormValuesFromConfig(next),
      agenticTool: next,
      agenticToolPresetId: undefined,
      ...(next !== 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
        codexIncludePlugins: undefined,
      }),
    });
  };

  const promptValue = Form.useWatch('prompt', form) ?? '';
  const nameValue = Form.useWatch('name', form) ?? '';

  const handleSave = async () => {
    setSaveError(null);
    if (!client) {
      setSaveError({ message: notConnectedMessage('save the webhook'), raw: null });
      return;
    }
    if (requiresSupportedToolSelection) return;
    let values: WebhookFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    // `getFieldsValue(true)` includes fields inside collapsed panels.
    const all = { ...form.getFieldsValue(true), ...values } as WebhookFormValues;

    setSaving(true);
    try {
      const payload: TeammateWebhookCreateData = {
        branch_id: branch.branch_id,
        name: (all.name ?? '').trim(),
        description: all.description?.trim() || undefined,
        prompt: (all.prompt ?? '').trim(),
        agentic_tool_config: buildAutomationAgenticToolConfig(
          agentTool,
          all,
          webhook?.agentic_tool_config
        ),
        mcp_server_ids: all.mcpServerIds ?? [],
        enabled: all.enabled ?? true,
        allow_concurrent_runs: all.allow_concurrent_runs ?? false,
      };

      let saved: TeammateWebhook;
      if (isEditing && webhook?.webhook_id) {
        const { branch_id: _branchId, ...patchPayload } = payload;
        saved = await client
          .service(TEAMMATE_WEBHOOKS_SERVICE)
          .patch(webhook.webhook_id, patchPayload satisfies TeammateWebhookPatchData);
        showSuccess('Webhook updated.');
      } else {
        saved = await client.service(TEAMMATE_WEBHOOKS_SERVICE).create(payload);
      }
      onSaved?.(saved, !isEditing);
      onClose();
    } catch (e: unknown) {
      setSaveError(describeActionError('save the webhook', e, { idempotent: isEditing }));
      if (!isEditing) setCreateUnconfirmed(isInFlightConnectionLossError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <DrillCrumbs
          parent="Webhooks"
          onParent={leave}
          current={webhook ? webhook.name || 'Untitled webhook' : 'New webhook'}
        />
      </div>
      {requiresSupportedToolSelection && (
        <Alert
          type="warning"
          showIcon
          title="This webhook uses an agent that's no longer available"
          description="Its saved settings are kept, but calls to it can't start a run. Choose an agent that's still available before you save this webhook."
          style={{ marginTop: 16 }}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        onValuesChange={() => setCreateUnconfirmed(false)}
      >
        <Form.Item name="enabled" label="Enabled" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, whitespace: true, message: 'Name is required' }]}
        >
          <Input placeholder="Jira triage" />
        </Form.Item>

        <Form.Item name="description" label="Description (optional)">
          <Input placeholder="What this webhook does" />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="Prompt template"
          rules={[
            { required: true, whitespace: true, message: 'Prompt is required' },
            {
              validator: async (_, value: string | undefined) => {
                if (!value?.trim()) return;
                const { validateTeammateWebhookPromptTemplate } = await loadPromptTemplates();
                const result = validateTeammateWebhookPromptTemplate(value);
                if (!result.ok) throw new Error(result.message);
              },
            },
          ]}
          extra={<TemplateHelp />}
        >
          <TextArea
            placeholder="A Jira issue was updated. Triage {{payload.issue.key}}: {{payload.issue.fields.summary}}"
            rows={6}
          />
        </Form.Item>

        <Form.Item label="Agent">
          <AgentSelectionGrid
            agents={AVAILABLE_AGENTS}
            selectedAgentId={requiresSupportedToolSelection ? null : agentTool}
            onSelect={(id) => handleAgentToolChange(id as AgenticToolName)}
            variant="select"
          />
        </Form.Item>

        {!requiresSupportedToolSelection && (
          <AgenticToolConfigurationPicker
            tool={agentTool}
            mcpServerById={mcpServerById}
            client={client}
            modelCatalogClient={
              executionOwner?.user_id && executionOwner.user_id === currentUser?.user_id
                ? client
                : null
            }
            branchId={branch.branch_id}
            defaultResolution="webhook-run"
            currentUser={executionOwner}
            configurationOwnerResolved={executionOwnerResolved}
          />
        )}

        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'preview',
              label: <Text strong>Preview with a sample payload</Text>,
              children: (
                <PromptPreview
                  templates={templates}
                  template={promptValue}
                  webhookName={nameValue}
                  webhookId={webhook?.webhook_id ?? PREVIEW_WEBHOOK_ID}
                  branch={branch}
                />
              ),
            },
            {
              key: 'webhook-settings',
              label: <Text strong>Webhook Settings</Text>,
              children: (
                <Form.Item
                  name="allow_concurrent_runs"
                  label="Concurrency"
                  extra="Controls overlap for this webhook only; other webhooks and schedules on this teammate are independent."
                >
                  <Radio.Group>
                    <Radio value={false}>
                      Queue calls while a run from this webhook is active (default)
                    </Radio>
                    <Radio value={true}>Start every call right away</Radio>
                  </Radio.Group>
                </Form.Item>
              ),
            },
          ]}
          style={{ marginTop: 16 }}
        />

        {!isEditing && (
          <Alert
            style={{ marginTop: 16 }}
            type="info"
            showIcon
            title="Agor shows the webhook URL and its token once you create it."
            description="The token is shown only once. Each call starts a new session on this teammate's branch, run as you."
          />
        )}
        {saveError && (
          <div ref={saveErrorRef}>
            <ActionErrorNotice error={saveError} style={{ marginTop: 16 }} />
          </div>
        )}
      </Form>
      <Space style={{ width: '100%', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button onClick={leave} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="primary"
          loading={saving}
          disabled={requiresSupportedToolSelection || createUnconfirmed}
          onClick={handleSave}
        >
          {isEditing ? 'Save' : 'Create'}
        </Button>
      </Space>
    </div>
  );
};
