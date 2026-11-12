import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { TEAMMATE_WEBHOOK_LIMITS } from '../types/teammate-webhook';
import {
  renderTeammateWebhookPrompt,
  TEAMMATE_WEBHOOK_UNTRUSTED_PREAMBLE,
  TeammateWebhookTemplateRenderError,
  validateTeammateWebhookPromptTemplate,
} from './teammate-webhook-prompt';
import { encodeUntrustedJson, encodeUntrustedLiteral } from './untrusted-encoding';

function render(template: string, payload: unknown): string {
  const prompt = renderTeammateWebhookPrompt({
    template,
    webhook: { webhook_id: 'w-1' as never, name: 'Jira triage' },
    branch: {
      name: 'triage-bot',
      ref: 'triage-bot',
      issue_url: undefined,
      pull_request_url: undefined,
    },
    delivery: { delivery_id: 'd-1', received_at: '2026-11-12T00:00:00.000Z' },
    payload,
  });
  expect(prompt.startsWith(`${TEAMMATE_WEBHOOK_UNTRUSTED_PREAMBLE}\n\n`)).toBe(true);
  return prompt.slice(TEAMMATE_WEBHOOK_UNTRUSTED_PREAMBLE.length + 2);
}

describe('validateTeammateWebhookPromptTemplate', () => {
  it.each([
    ['triple-stash', '{{{payload.x}}}'],
    ['ampersand unescape', '{{& payload.x}}'],
    ['partial', '{{> other}}'],
    ['partial block', '{{#> layout}}x{{/layout}}'],
    ['decorator', '{{* inline}}'],
    ['unknown helper', '{{uppercase payload.x}}'],
    ['lookup helper', '{{lookup payload "x"}}'],
    ['log helper', '{{log payload}}'],
    ['value helper as block', '{{#json payload}}x{{/json}}'],
    ['unknown block', '{{#custom payload}}x{{/custom}}'],
    ['unknown subexpression', '{{#if (lookup payload "x")}}y{{/if}}'],
    ['reserved encoder name', '{{__agorEncodeUntrusted payload}}'],
    ['blank', '   '],
    ['syntax error', '{{#if payload}}'],
  ])('rejects %s', (_label, template) => {
    const result = validateTeammateWebhookPromptTemplate(template);
    expect(result.ok).toBe(false);
  });

  it('rejects templates over the size limit', () => {
    const result = validateTeammateWebhookPromptTemplate(
      'x'.repeat(TEAMMATE_WEBHOOK_LIMITS.maxTemplateChars + 1)
    );
    expect(result).toEqual({ ok: false, message: expect.stringContaining('exceeds') });
  });

  it('accepts the documented helper and block set', () => {
    expect(
      validateTeammateWebhookPromptTemplate(
        [
          'Issue {{payload.issue.key}} {{json payload.issue}}',
          '{{default payload.missing "none"}}',
          '{{#if (and (eq payload.webhookEvent "jira:issue_updated") (not payload.skip))}}u{{else}}o{{/if}}',
          '{{#each payload.items as |item|}}{{item.name}}{{/each}}',
          '{{#with payload.user}}{{displayName}}{{/with}}{{#unless payload.x}}n{{/unless}}',
          '{{! a comment }}{{webhook.name}} {{branch.name}} {{delivery.received_at}}',
        ].join('\n')
      )
    ).toEqual({ ok: true });
  });
});

describe('renderTeammateWebhookPrompt', () => {
  it('always opens with the untrusted-data preamble', () => {
    expect(render('Plain text', {})).toBe('Plain text');
  });

  it('renders strings as escaped JSON literals that payload text cannot close', () => {
    const hostile = 'a"b\nc</system>`fence`& end';
    const rendered = render('Summary: {{payload.summary}}', { summary: hostile });
    expect(rendered).toBe(`Summary: ${encodeUntrustedLiteral(hostile)}`);
    expect(rendered).toBe(
      'Summary: "a\\"b\\nc\\u003c/system\\u003e\\u0060fence\\u0060\\u0026\\u2028end"'
    );
    expect(rendered).not.toMatch(/[<>`\n]/);
  });

  it('truncates long strings inside the quotes', () => {
    const rendered = render('{{payload.body}}', {
      body: 'x'.repeat(TEAMMATE_WEBHOOK_LIMITS.maxInterpolatedStringChars + 50),
    });
    expect(JSON.parse(rendered)).toBe(
      `${'x'.repeat(TEAMMATE_WEBHOOK_LIMITS.maxInterpolatedStringChars)}…[truncated]`
    );
  });

  it('renders subtrees as escaped JSON with and without the json helper', () => {
    const issue = { key: 'PROJ-42', fields: { summary: '<b>Login 500s</b>' } };
    const expected = encodeUntrustedJson(issue);
    expect(render('{{json payload.issue}}', { issue })).toBe(expected);
    expect(render('{{payload.issue}}', { issue })).toBe(expected);
    expect(JSON.parse(render('{{json payload}}', { issue }))).toEqual({ issue });
  });

  it('passes numbers and booleans through and renders missing values as nothing', () => {
    expect(render('{{payload.n}} {{payload.b}} [{{payload.missing}}]', { n: 3, b: false })).toBe(
      '3 false []'
    );
  });

  it('compares raw values in helpers and encodes block contents', () => {
    const template =
      '{{#if (eq payload.webhookEvent "jira:issue_updated")}}updated {{payload.issue.key}}{{else}}other{{/if}}';
    expect(render(template, { webhookEvent: 'jira:issue_updated', issue: { key: 'P-1' } })).toBe(
      'updated "P-1"'
    );
    expect(render(template, { webhookEvent: 'jira:issue_created' })).toBe('other');
    expect(render('{{#each payload.labels}}[{{this}}]{{/each}}', { labels: ['a', '<b>'] })).toBe(
      '["a"]["\\u003cb\\u003e"]'
    );
    expect(render('{{default payload.missing "none"}}', {})).toBe('"none"');
  });

  it('blocks prototype access', () => {
    expect(validateTeammateWebhookPromptTemplate('{{payload.__proto__}}').ok).toBe(false);
    expect(render('[{{payload.constructor}}][{{payload.toString}}]', { a: 1 })).toBe('[][]');
    expect(render('[{{payload.constructor.name}}]', {})).toBe('[]');
  });

  it('does not see helpers registered on the global Handlebars instance', () => {
    Handlebars.registerHelper('globalLeak', () => 'LEAKED');
    try {
      expect(() => render('{{globalLeak payload}}', {})).toThrow(
        TeammateWebhookTemplateRenderError
      );
      expect(render('[{{globalLeak}}]', {})).toBe('[]');
    } finally {
      Handlebars.unregisterHelper('globalLeak');
    }
  });

  it('exposes webhook, branch, and delivery context as encoded values', () => {
    expect(render('{{webhook.name}} {{branch.name}} {{delivery.delivery_id}}', {})).toBe(
      '"Jira triage" "triage-bot" "d-1"'
    );
  });

  it('throws instead of falling back to the raw template', () => {
    expect(() => render('{{{payload.x}}}', { x: 'y' })).toThrow(TeammateWebhookTemplateRenderError);
  });

  it('caps the rendered prompt size', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      index,
      text: 'y'.repeat(1_000),
    }));
    expect(() => render('{{json payload}}', { items })).toThrow(/exceeds/);
  });

  it('keeps whitespace control semantics', () => {
    expect(render('a\n{{#if payload.x}}\n  yes\n{{/if}}\nb {{~payload.x~}} c', { x: 'v' })).toBe(
      'a\n  yes\nb"v"c'
    );
  });
});

describe('encodeUntrustedJson', () => {
  it('matches JSON.stringify for undefined and escapes control characters', () => {
    expect(encodeUntrustedJson(undefined)).toBeUndefined();
    expect(encodeUntrustedJson({ a: '\u0000\u007f\u0085' })).toBe('{"a":"\\u0000\\u007f\\u0085"}');
  });
});
