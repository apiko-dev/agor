/**
 * Show-once panel for a freshly issued webhook token (PersonalApiKeysTab
 * pattern). The token is never retrievable again; closing the panel drops it.
 */

import type { TeammateWebhookIssuedToken } from '@agor-live/client';
import { TEAMMATE_WEBHOOK_INGRESS_PREFIX } from '@agor-live/client';
import { CopyOutlined, KeyOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Space, Typography, theme } from 'antd';
import { copyToClipboard } from '../../utils/clipboard';
import { useThemedMessage } from '../../utils/message';

const { Paragraph, Text, Title } = Typography;

export interface IssuedTokenPanelProps {
  issued: TeammateWebhookIssuedToken;
  webhookName: string;
  onDone: () => void;
}

export const IssuedTokenPanel: React.FC<IssuedTokenPanelProps> = ({
  issued,
  webhookName,
  onDone,
}) => {
  const { token: themeToken } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const url =
    issued.ingress_url ??
    `<your Agor address>${TEAMMATE_WEBHOOK_INGRESS_PREFIX}${issued.webhook_id}/`;
  const curl = [
    `curl -X POST '${url}' \\`,
    `  -H 'Authorization: Bearer ${issued.token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"hello": "world"}'`,
  ].join('\n');

  const handleCopyToken = async () => {
    if (await copyToClipboard(issued.token)) {
      showSuccess('Token copied.');
    } else {
      showError("Couldn't copy. Select the token and copy it manually.");
    }
  };

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        <Space>
          <KeyOutlined />
          Token for {webhookName || 'Untitled webhook'}
        </Space>
      </Title>
      <Alert
        type="warning"
        showIcon
        title="Copy this token now"
        description="This is the only time it will be shown. If you lose it, rotate the token and update the sender."
        style={{ marginBottom: themeToken.margin }}
      />

      <Text strong>Webhook URL</Text>
      {issued.ingress_url ? (
        <Paragraph copyable={{ text: issued.ingress_url }} code style={{ wordBreak: 'break-all' }}>
          {issued.ingress_url}
        </Paragraph>
      ) : (
        <Alert
          type="info"
          showIcon
          title="The public URL isn't known yet"
          description={
            <span>
              Agor doesn't know this workspace's public address yet. The URL is that address
              followed by{' '}
              <Text code>{`${TEAMMATE_WEBHOOK_INGRESS_PREFIX}${issued.webhook_id}/`}</Text>.
            </span>
          }
          style={{ marginTop: themeToken.marginXS, marginBottom: themeToken.margin }}
        />
      )}

      <Text strong>Token</Text>
      <Input.TextArea
        aria-label="Webhook token"
        value={issued.token}
        readOnly
        autoSize={{ minRows: 2 }}
        style={{
          fontFamily: themeToken.fontFamilyCode,
          marginTop: themeToken.marginXXS,
          marginBottom: themeToken.marginXS,
        }}
      />
      <Button icon={<CopyOutlined />} onClick={handleCopyToken} block>
        Copy token
      </Button>

      <Paragraph type="secondary" style={{ marginTop: themeToken.margin }}>
        Send the token in an <Text code>Authorization: Bearer</Text> header:
      </Paragraph>
      <Paragraph copyable={{ text: curl }}>
        <pre
          style={{
            margin: 0,
            padding: themeToken.paddingSM,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontFamily: themeToken.fontFamilyCode,
            fontSize: themeToken.fontSizeSM,
            background: themeToken.colorFillTertiary,
            borderRadius: themeToken.borderRadius,
          }}
        >
          {curl}
        </pre>
      </Paragraph>
      <Paragraph type="secondary">
        If the sender can't set headers (for example Jira Cloud admin webhooks), add{' '}
        <Text code>?token=&lt;token&gt;</Text> to the URL instead. URLs often end up in logs, so
        prefer the header when you can.
      </Paragraph>

      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        <Button type="primary" onClick={onDone}>
          I've copied it
        </Button>
      </Space>
    </div>
  );
};
