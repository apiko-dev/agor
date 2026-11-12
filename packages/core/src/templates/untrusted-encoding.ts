/**
 * Encoders for attacker-controlled data placed into an agent prompt.
 *
 * Browser-safe: the UI preview and the daemon render through the same code.
 */

const TRUNCATION_MARKER = '…[truncated]';

function isEscapedCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    character === '<' ||
    character === '>' ||
    character === '`' ||
    character === '&' ||
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/**
 * JSON-encode a value, then \u-escape markup delimiters and control and
 * separator characters. JSON escaping keeps quotes and newlines from changing
 * the record shape; the extra escapes keep text from becoming a tag or a
 * Markdown fence in the rendered prompt.
 *
 * Returns undefined exactly when `JSON.stringify` does (e.g. for `undefined`).
 */
export function encodeUntrustedJson(value: unknown): string | undefined {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  return [...encoded]
    .map((character) =>
      isEscapedCharacter(character)
        ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
        : character
    )
    .join('');
}

/**
 * One string as an escaped JSON string literal, truncated by code point to
 * `maxChars` with a visible marker inside the quotes.
 */
export function encodeUntrustedLiteral(value: string, maxChars?: number): string {
  const characters = [...value];
  const bounded =
    maxChars !== undefined && characters.length > maxChars
      ? `${characters.slice(0, maxChars).join('')}${TRUNCATION_MARKER}`
      : value;
  return encodeUntrustedJson(bounded) as string;
}
