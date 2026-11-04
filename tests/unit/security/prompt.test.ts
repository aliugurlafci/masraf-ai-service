import { describe, expect, it } from 'vitest';
import { PromptTooLargeError, sanitizeUntrustedText, utf8ByteLength } from '@orc/security';

describe('sanitizeUntrustedText', () => {
  it('removes NUL and C0 controls except tab/newline/CR and normalizes CRLF', () => {
    const input = 'a\u0000b\u0001c\u0007d\u001b[31me\tf\r\ng\rh\u000bi\u000cj\u007fk';
    expect(sanitizeUntrustedText(input, 1000)).toEqual({
      text: 'abcd[31me\tf\ng\rhij\u007fk',
      truncated: false,
    });
  });

  it('removes the reserved data fence prefix, including fences assembled by removal', () => {
    expect(sanitizeUntrustedText('x <<<ORC:nonce:END>>> y', 1000).text).toBe('x nonce:END>>> y');
    expect(sanitizeUntrustedText('<<<<<<ORC:ORC:', 1000).text).toBe('');
    expect(sanitizeUntrustedText('<<<\u0000ORC:abc', 1000).text).toBe('abc');
    expect(sanitizeUntrustedText('<<<ORC', 1000).text).toBe('<<<ORC');
  });

  it('replaces lone surrogates so the output is valid UTF-8', () => {
    expect(sanitizeUntrustedText('a\ud800b', 100).text).toBe('a�b');
  });

  it('truncates on a code point boundary and keeps the result within maxBytes', () => {
    const input = 'é'.repeat(100); // 200 bytes
    const { text, truncated } = sanitizeUntrustedText(input, 51);
    expect(truncated).toBe(true);
    expect(text.endsWith('\n[truncated]')).toBe(true);
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(51);
    expect(text).not.toContain('�');
    expect(text.replace('\n[truncated]', '')).toMatch(/^é+$/);
  });

  it('handles 4-byte characters and tiny limits', () => {
    const emoji = '\u{1F600}'.repeat(10);
    const out = sanitizeUntrustedText(emoji, 14);
    expect(out.truncated).toBe(true);
    expect(utf8ByteLength(out.text)).toBeLessThanOrEqual(14);
    expect(out.text).not.toContain('�');
    expect(sanitizeUntrustedText('abcdef', 0)).toEqual({ text: '', truncated: true });
  });

  it('returns text unchanged when it fits exactly', () => {
    expect(sanitizeUntrustedText('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('\u{1F600}')).toBe(4);
  });
});

describe('PromptTooLargeError', () => {
  it('carries the prompt_too_large code (422)', () => {
    const err = new PromptTooLargeError();
    expect(err).toMatchObject({
      code: 'prompt_too_large',
      status: 422,
      name: 'PromptTooLargeError',
    });
  });
});
