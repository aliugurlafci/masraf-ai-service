import { describe, expect, it } from 'vitest';
import { createSecretRegistry, createStreamMasker } from '@orc/security';

const SECRET = 'S3cr3t-Value-For-Registry-0001';
const ANTHROPIC = 'sk-ant-FAKE0000000000000000000000';

function run(chunks: readonly string[], registrySecrets: readonly string[] = [SECRET]): string {
  const registry = createSecretRegistry();
  for (const s of registrySecrets) registry.add(s);
  const masker = createStreamMasker(registry);
  return chunks.map((c) => masker.push(c)).join('') + masker.flush();
}

describe('createStreamMasker', () => {
  it('masks a registered secret split across chunk boundaries', () => {
    const text = `log line\nconnect with ${SECRET} now\nnext\n`;
    for (let split = 1; split < text.length; split += 1) {
      const out = run([text.slice(0, split), text.slice(split)]);
      expect(out).not.toContain(SECRET.slice(0, 12));
      expect(out).toContain('[REDACTED]');
    }
  });

  it('masks a pattern secret split character by character', () => {
    const text = `token in output: ${ANTHROPIC} end\n`;
    const out = run([...text]);
    expect(out).toBe('token in output: [REDACTED] end\n');
  });

  it('holds partial lines and releases complete lines (\\n and \\r)', () => {
    const masker = createStreamMasker();
    expect(masker.push('abc')).toBe('');
    expect(masker.pendingChars).toBe(3);
    expect(masker.push('def\nghi')).toBe('abcdef\n');
    expect(masker.push('\rprogress')).toBe('ghi\r');
    expect(masker.flush()).toBe('progress');
    expect(masker.pendingChars).toBe(0);
  });

  it('masks a multi-line private key delivered across lines and chunks', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAexample0000000000000000000000000000',
      'line2example000000000000000000000000000000000000',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const text = `before\n${key}\nafter\n`;
    const chunks = text.split('\n').map((l, i, a) => (i < a.length - 1 ? `${l}\n` : l));
    const out = run(chunks, []);
    expect(out).toBe('before\n[REDACTED]\nafter\n');
  });

  it('bounds the held tail for endless lines without splitting a secret', () => {
    const registry = createSecretRegistry();
    registry.add(SECRET);
    const masker = createStreamMasker(registry, { maxHoldChars: 4096 });
    let emitted = '';
    const filler = 'x'.repeat(3000);
    for (let i = 0; i < 20; i += 1) emitted += masker.push(`${filler}${i === 10 ? SECRET : ''}`);
    expect(masker.pendingChars).toBeLessThanOrEqual(4096 + 3000 + SECRET.length);
    emitted += masker.flush();
    expect(emitted).not.toContain(SECRET);
    expect(emitted).toContain('[REDACTED]');
    expect(emitted.replace('[REDACTED]', '')).toBe('x'.repeat(60_000));
  });

  it('ignores empty chunks', () => {
    const masker = createStreamMasker();
    expect(masker.push('')).toBe('');
    expect(masker.flush()).toBe('');
  });
});
