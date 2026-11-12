/**
 * Teammate webhooks for a branch: list, create / edit / delete, enable,
 * token issue / rotate, and the deliveries drawer. Mirrors ScheduleTab.
 */

import type {
  AgorClient,
  Branch,
  DirectoryUser,
  MCPServer,
  TeammateWebhook,
  TeammateWebhookIssuedToken,
  User,
} from '@agor-live/client';
import {
  shortId,
  TEAMMATE_WEBHOOK_INGRESS_PREFIX,
  TEAMMATE_WEBHOOKS_SERVICE,
} from '@agor-live/client';
import {
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { Button, Empty, Input, Popconfirm, Space, Spin, Switch, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import {
  type ActionErrorCopy,
  describeActionError,
  errorMessage,
  formatActionError,
} from '../../../utils/connectionErrors';
import { useThemedMessage } from '../../../utils/message';
import { ActionErrorNotice } from '../../CompactNotice';
import { ResponsiveTable } from '../../SettingsModal/ResponsiveTable';
import { TeammateWebhookDeliveriesPanel } from '../../TeammateWebhookDeliveriesPanel';
import { IssuedTokenPanel, TeammateWebhookForm } from '../../TeammateWebhookForm';

const { Text } = Typography;

interface WebhookTabProps {
  branch: Branch;
  client: AgorClient | null;
  mcpServerById?: Map<string, MCPServer>;
  currentUser?: User | null;
  userById?: Map<string, DirectoryUser>;
  onOpenSession?: (sessionId: string) => void;
  /** The open webhook form's dirty getter (null when closed), for the branch editor's leave guard. */
  onDraftChange?: (isDirty: (() => boolean) | null) => void;
}

/** What the tab shows in place: the list, the edit form, or a just-issued token (shown once). */
type WebhookTabView =
  | { kind: 'list' }
  | { kind: 'form'; webhook: TeammateWebhook | null }
  | { kind: 'token'; issued: TeammateWebhookIssuedToken; webhookName: string };

const ellipsisStyle = {
  display: 'block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const userLabel = (
  userId: string,
  userById: Map<string, DirectoryUser>,
  currentUser?: User | null
) => {
  const user = userById.get(userId);
  const label = user?.email ?? user?.name ?? shortId(userId);
  return currentUser?.user_id === userId ? `${label} (you)` : label;
};

export const WebhookTab: React.FC<WebhookTabProps> = ({
  branch,
  client,
  mcpServerById = new Map(),
  currentUser,
  userById = new Map<string, DirectoryUser>(),
  onOpenSession,
  onDraftChange,
}) => {
  const { showError, showSuccess } = useThemedMessage();
  const [webhooks, setWebhooks] = useState<TeammateWebhook[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ActionErrorCopy | null>(null);
  const [view, setView] = useState<WebhookTabView>({ kind: 'list' });
  const [tokenError, setTokenError] = useState<{
    webhook: TeammateWebhook;
    error: ActionErrorCopy;
  } | null>(null);
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [deliveriesWebhook, setDeliveriesWebhook] = useState<TeammateWebhook | null>(null);

  const editingWebhook = view.kind === 'form' ? view.webhook : null;
  const storedExecutionOwner = editingWebhook ? userById.get(editingWebhook.created_by) : undefined;
  const executionOwner =
    !editingWebhook || editingWebhook.created_by === currentUser?.user_id
      ? currentUser
      : storedExecutionOwner?.user_id === editingWebhook.created_by
        ? storedExecutionOwner
        : null;

  const fetchWebhooks = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.service(TEAMMATE_WEBHOOKS_SERVICE).find({
        query: { branch_id: branch.branch_id, $sort: { created_at: -1 } },
      });
      setWebhooks(Array.isArray(result) ? result : result.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeActionError('load webhooks', err, { idempotent: true }));
    } finally {
      setLoading(false);
    }
  }, [client, branch.branch_id]);

  useEffect(() => {
    void fetchWebhooks();
  }, [fetchWebhooks]);

  // The service emits events for every branch the caller can see; keep ours.
  useEffect(() => {
    if (!client) return;
    const service = client.service(TEAMMATE_WEBHOOKS_SERVICE);
    const upsert = (w: TeammateWebhook) => {
      if (w.branch_id !== branch.branch_id) return;
      setWebhooks((prev) =>
        prev.some((p) => p.webhook_id === w.webhook_id)
          ? prev.map((p) => (p.webhook_id === w.webhook_id ? w : p))
          : [w, ...prev]
      );
    };
    const onRemoved = (w: TeammateWebhook) => {
      setWebhooks((prev) => prev.filter((p) => p.webhook_id !== w.webhook_id));
    };
    service.on('created', upsert);
    service.on('patched', upsert);
    service.on('removed', onRemoved);
    return () => {
      service.off('created', upsert);
      service.off('patched', upsert);
      service.off('removed', onRemoved);
    };
  }, [client, branch.branch_id]);

  const issueToken = async (webhook: TeammateWebhook, { justCreated = false } = {}) => {
    if (!client) return;
    setIssuingId(webhook.webhook_id);
    try {
      const issued = await client
        .service(`${TEAMMATE_WEBHOOKS_SERVICE}/${webhook.webhook_id}/token`)
        .create({});
      setTokenError(null);
      setView({ kind: 'token', issued, webhookName: webhook.name });
    } catch (err) {
      setTokenError({
        webhook,
        error: justCreated
          ? {
              message: `Webhook "${webhook.name}" was created, but its token wasn't issued. Calls to it are rejected until it has one.`,
              raw: errorMessage(err),
            }
          : describeActionError('issue the token', err, { idempotent: false }),
      });
    } finally {
      setIssuingId(null);
    }
  };

  const handleSaved = (saved: TeammateWebhook, created: boolean) => {
    void fetchWebhooks();
    if (created) void issueToken(saved, { justCreated: true });
  };

  const handleDelete = async (webhook: TeammateWebhook) => {
    if (!client) return;
    try {
      await client.service(TEAMMATE_WEBHOOKS_SERVICE).remove(webhook.webhook_id);
      if (tokenError?.webhook.webhook_id === webhook.webhook_id) setTokenError(null);
      showSuccess(`Webhook "${webhook.name}" deleted.`);
    } catch (err) {
      showError(formatActionError('delete the webhook', err, { idempotent: true }));
    }
  };

  const handleToggleEnabled = async (webhook: TeammateWebhook, enabled: boolean) => {
    if (!client) return;
    try {
      await client.service(TEAMMATE_WEBHOOKS_SERVICE).patch(webhook.webhook_id, { enabled });
    } catch (err) {
      showError(
        formatActionError(enabled ? 'turn the webhook on' : 'turn the webhook off', err, {
          idempotent: true,
        })
      );
    }
  };

  // The daemon only lets the creator patch a webhook or issue its token, because runs execute as them.
  const creatorOnlyTitle = (w: TeammateWebhook, title: string) =>
    w.created_by === currentUser?.user_id
      ? title
      : `Only ${userLabel(w.created_by, userById, currentUser)} can change this webhook`;
  const isCreator = (w: TeammateWebhook) => w.created_by === currentUser?.user_id;

  const columns: TableColumnsType<TeammateWebhook> = [
    {
      title: 'On',
      key: 'enabled',
      width: 50,
      render: (_, w) => (
        <Tooltip title={creatorOnlyTitle(w, w.enabled ? 'Disable webhook' : 'Enable webhook')}>
          <Switch
            disabled={!isCreator(w)}
            aria-label={`${w.enabled ? 'Disable' : 'Enable'} webhook ${w.name}`}
            checked={w.enabled}
            onChange={(v) => handleToggleEnabled(w, v)}
            size="small"
          />
        </Tooltip>
      ),
    },
    {
      title: 'Title',
      key: 'name',
      width: 220,
      render: (_, w) => (
        <Space direction="vertical" size={0} style={{ display: 'flex', minWidth: 0 }}>
          <Text style={ellipsisStyle} title={w.name} aria-label={`Webhook title: ${w.name}`}>
            {w.name || 'Untitled webhook'}
          </Text>
          {w.description ? (
            <Text type="secondary" style={ellipsisStyle} title={w.description}>
              {w.description}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: 'Token',
      key: 'token',
      width: 170,
      render: (_, w) =>
        w.token_hint ? (
          <Tooltip
            title={
              <Space direction="vertical" size={2}>
                <Text>
                  Issued {w.token_issued_at ? new Date(w.token_issued_at).toLocaleString() : ''}
                </Text>
                <Text>
                  Path: <Text code>{`${TEAMMATE_WEBHOOK_INGRESS_PREFIX}${w.webhook_id}/`}</Text>
                </Text>
                <Text>Runs as: {userLabel(w.created_by, userById, currentUser)}</Text>
              </Space>
            }
          >
            <Text code style={ellipsisStyle}>
              {w.token_hint}…
            </Text>
          </Tooltip>
        ) : (
          <Text type="warning">Not issued</Text>
        ),
    },
    {
      title: 'Concurrency',
      key: 'concurrency',
      width: 120,
      render: (_, w) => (
        <Text type="secondary">{w.allow_concurrent_runs ? 'Overlapping' : 'One at a time'}</Text>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 150,
      render: (_, w) => (
        <Space size={2} wrap={false}>
          {!isCreator(w) ? null : w.token_hint ? (
            <Popconfirm
              title="Rotate token?"
              description="The current token stops working immediately. Update every sender that uses it."
              onConfirm={() => issueToken(w)}
              okText="Rotate"
              cancelText="Cancel"
              okButtonProps={{ danger: true }}
            >
              <Tooltip title="Rotate token">
                <Button
                  type="text"
                  size="small"
                  icon={<KeyOutlined />}
                  loading={issuingId === w.webhook_id}
                  aria-label={`Rotate token for webhook ${w.name}`}
                />
              </Tooltip>
            </Popconfirm>
          ) : (
            <Tooltip title="Issue token">
              <Button
                type="text"
                size="small"
                icon={<KeyOutlined />}
                loading={issuingId === w.webhook_id}
                onClick={() => issueToken(w)}
                aria-label={`Issue token for webhook ${w.name}`}
              />
            </Tooltip>
          )}
          <Tooltip title="View deliveries">
            <Button
              type="text"
              size="small"
              icon={<UnorderedListOutlined />}
              onClick={() => setDeliveriesWebhook(w)}
              aria-label={`View deliveries for webhook ${w.name}`}
            />
          </Tooltip>
          {isCreator(w) ? (
            <Tooltip title="Edit">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => setView({ kind: 'form', webhook: w })}
                aria-label={`Edit webhook ${w.name}`}
              />
            </Tooltip>
          ) : null}
          <Popconfirm
            title="Delete webhook?"
            description={`Calls to "${w.name}" will stop working.`}
            onConfirm={() => handleDelete(w)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="Delete">
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                danger
                aria-label={`Delete webhook ${w.name}`}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (view.kind === 'form') {
    return (
      <div style={{ padding: 16, minWidth: 0 }}>
        <TeammateWebhookForm
          onClose={() => setView((v) => (v.kind === 'form' ? { kind: 'list' } : v))}
          branch={branch}
          webhook={view.webhook}
          mcpServerById={mcpServerById}
          client={client}
          executionOwner={executionOwner}
          currentUser={currentUser}
          onSaved={handleSaved}
          onDraftChange={onDraftChange}
        />
      </div>
    );
  }

  if (view.kind === 'token') {
    return (
      <div style={{ padding: 16, minWidth: 0 }}>
        <IssuedTokenPanel
          issued={view.issued}
          webhookName={view.webhookName}
          onDone={() => setView({ kind: 'list' })}
        />
      </div>
    );
  }

  const term = search.trim().toLowerCase();
  const visibleWebhooks = term
    ? webhooks.filter(
        (w) =>
          w.name.toLowerCase().includes(term) || (w.description ?? '').toLowerCase().includes(term)
      )
    : webhooks;
  const openNew = () => setView({ kind: 'form', webhook: null });

  return (
    <div style={{ padding: 16, minWidth: 0 }}>
      <div style={{ marginBottom: 8, minWidth: 0 }}>
        <Text style={ellipsisStyle}>Webhooks for {branch.name}</Text>
        <Text type="secondary" style={{ display: 'block', marginTop: 2 }}>
          Let another system, such as Jira, start this teammate over HTTP. Each call starts a new
          session on this branch with your prompt template.
        </Text>
      </div>
      {tokenError && (
        <ActionErrorNotice
          error={tokenError.error}
          action={{
            label: 'Issue token',
            onClick: () => void issueToken(tokenError.webhook),
          }}
          style={{ marginBottom: 12 }}
        />
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
          minWidth: 0,
        }}
      >
        <Input
          allowClear
          placeholder="Search webhooks by name or description"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
          disabled={webhooks.length === 0}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={openNew}
          style={{ flex: '0 0 auto' }}
        >
          New
        </Button>
      </div>
      {loading ? (
        <Spin />
      ) : loadError ? (
        <ActionErrorNotice
          error={loadError}
          action={{ label: 'Try again', onClick: () => void fetchWebhooks() }}
        />
      ) : webhooks.length === 0 ? (
        <Empty description="No webhooks yet. Add one to let another system start this teammate.">
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
            New webhook
          </Button>
        </Empty>
      ) : visibleWebhooks.length === 0 ? (
        <Empty description={`No webhooks match "${search.trim()}"`} />
      ) : (
        <ResponsiveTable<TeammateWebhook>
          primaryColumnKey="name"
          rowKey="webhook_id"
          dataSource={visibleWebhooks}
          columns={columns}
          pagination={false}
          size="small"
          tableLayout="fixed"
          style={{ width: '100%' }}
        />
      )}

      <TeammateWebhookDeliveriesPanel
        open={deliveriesWebhook !== null}
        onClose={() => setDeliveriesWebhook(null)}
        webhook={deliveriesWebhook}
        client={client}
        onOpenSession={onOpenSession}
      />
    </div>
  );
};
