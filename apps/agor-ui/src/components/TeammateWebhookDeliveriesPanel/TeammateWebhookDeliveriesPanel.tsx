/**
 * Recent deliveries for one teammate webhook, live by realtime. Opens as a
 * Drawer from the Webhooks tab (mirrors ScheduleRunsPanel).
 */

import type {
  AgorClient,
  TeammateWebhook,
  TeammateWebhookDelivery,
  TeammateWebhookFailureCode,
} from '@agor-live/client';
import { TEAMMATE_WEBHOOK_DELIVERIES_SERVICE } from '@agor-live/client';
import type { TableColumnsType } from 'antd';
import { Button, Drawer, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { type ActionErrorCopy, describeActionError } from '../../utils/connectionErrors';
import { ActionErrorNotice } from '../CompactNotice';

const DELIVERIES_LIMIT = 20;

export interface TeammateWebhookDeliveriesPanelProps {
  open: boolean;
  onClose: () => void;
  webhook: TeammateWebhook | null;
  client: AgorClient | null;
  /** Open the session in the canvas (host wires routing). */
  onOpenSession?: (sessionId: string) => void;
}

export function describeFailureCode(code: TeammateWebhookFailureCode): string {
  switch (code) {
    case 'webhook_disabled':
      return 'The webhook was turned off or deleted before this call could run.';
    case 'branch_not_teammate':
      return 'This branch is no longer a teammate.';
    case 'permission_revoked':
      return "The webhook's creator no longer has permission to run this teammate.";
    case 'creator_unavailable':
      return "The webhook's creator account can't run sessions anymore.";
    case 'agentic_tool_removed':
      return "The webhook's agent is no longer available. Edit the webhook to choose another.";
    case 'invalid_config':
      return "The webhook's agent configuration isn't valid. Edit the webhook to fix it.";
    case 'tool_unavailable':
      return "The webhook's agent isn't available in this workspace.";
    case 'template_render_failed':
      return "The prompt template couldn't be filled in with this payload.";
    case 'payload_unreadable':
      return "The stored payload couldn't be read.";
    case 'payload_expired':
      return 'The call waited in the queue too long and expired.';
    case 'retries_exhausted':
      return 'Starting the run kept failing, so Agor stopped retrying.';
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

export function describeDelivery(delivery: TeammateWebhookDelivery): {
  label: string;
  color: string;
  detail: string | null;
} {
  switch (delivery.status) {
    case 'queued':
      return {
        label: 'Queued',
        color: 'default',
        detail:
          delivery.defer_reason === 'busy'
            ? 'Waiting for the previous run'
            : delivery.defer_reason === 'transient_retry'
              ? 'Retrying after an error'
              : 'Waiting to start',
      };
    case 'processing':
      return { label: 'Starting', color: 'processing', detail: null };
    case 'started':
      return { label: 'Started', color: 'success', detail: null };
    case 'failed':
      return {
        label: 'Failed',
        color: 'error',
        detail: describeFailureCode(delivery.failure_code),
      };
    default: {
      const unreachable: never = delivery;
      return unreachable;
    }
  }
}

const formatTimestamp = (iso: string) => new Date(iso).toLocaleString();

export const TeammateWebhookDeliveriesPanel: React.FC<TeammateWebhookDeliveriesPanelProps> = ({
  open,
  onClose,
  webhook,
  client,
  onOpenSession,
}) => {
  const [deliveries, setDeliveries] = useState<TeammateWebhookDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ActionErrorCopy | null>(null);
  const webhookId = webhook?.webhook_id;

  const fetchDeliveries = useCallback(async () => {
    if (!client || !webhookId) return;
    setLoading(true);
    try {
      const result = await client.service(TEAMMATE_WEBHOOK_DELIVERIES_SERVICE).find({
        query: { webhook_id: webhookId, $limit: DELIVERIES_LIMIT, $sort: { received_at: -1 } },
      });
      setDeliveries(Array.isArray(result) ? result : result.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(describeActionError('load deliveries', err, { idempotent: true }));
    } finally {
      setLoading(false);
    }
  }, [client, webhookId]);

  useEffect(() => {
    if (open) void fetchDeliveries();
  }, [open, fetchDeliveries]);

  useEffect(() => {
    if (!client || !open || !webhookId) return;
    const service = client.service(TEAMMATE_WEBHOOK_DELIVERIES_SERVICE);
    const upsert = (delivery: TeammateWebhookDelivery) => {
      if (delivery.webhook_id !== webhookId) return;
      setDeliveries((prev) =>
        prev.some((d) => d.delivery_id === delivery.delivery_id)
          ? prev.map((d) => (d.delivery_id === delivery.delivery_id ? delivery : d))
          : [delivery, ...prev].slice(0, DELIVERIES_LIMIT)
      );
    };
    service.on('created', upsert);
    service.on('patched', upsert);
    return () => {
      service.off('created', upsert);
      service.off('patched', upsert);
    };
  }, [client, open, webhookId]);

  const columns: TableColumnsType<TeammateWebhookDelivery> = [
    {
      title: 'Received',
      key: 'received_at',
      width: 180,
      render: (_, d) => formatTimestamp(d.received_at),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, d) => {
        const { label, color, detail } = describeDelivery(d);
        return (
          <Space direction="vertical" size={0}>
            <Tag color={color}>{label}</Tag>
            {detail ? <Typography.Text type="secondary">{detail}</Typography.Text> : null}
          </Space>
        );
      },
    },
    {
      title: '',
      key: 'open',
      width: 80,
      render: (_, d) =>
        d.session_id && onOpenSession ? (
          <Button
            type="link"
            size="small"
            onClick={() => d.session_id && onOpenSession(d.session_id)}
            aria-label={`Open session for delivery received ${formatTimestamp(d.received_at)}`}
          >
            Open
          </Button>
        ) : null,
    },
  ];

  return (
    <Drawer
      title={webhook ? `Deliveries — ${webhook.name}` : 'Deliveries'}
      open={open}
      onClose={onClose}
      width={640}
      destroyOnHidden
    >
      {loading ? (
        <Spin />
      ) : loadError ? (
        <ActionErrorNotice
          error={loadError}
          action={{ label: 'Try again', onClick: () => void fetchDeliveries() }}
        />
      ) : deliveries.length === 0 ? (
        <Empty description="No calls yet." />
      ) : (
        <Table
          rowKey="delivery_id"
          dataSource={deliveries}
          columns={columns}
          pagination={false}
          size="small"
        />
      )}
    </Drawer>
  );
};
