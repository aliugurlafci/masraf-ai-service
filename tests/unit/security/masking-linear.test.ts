import { describe, expect, it } from 'vitest';
import { createSecretRegistry, createStreamMasker, maskText } from '@orc/security';
import type { SecretRegistry } from '@orc/security';

const R = '[REDACTED]';
const MIB = 1 << 20;

/**
 * The pre-linear implementation (plain `String.prototype.replace` over the §17.2 regexes). It is
 * O(n^2) on long separator-free lines but defines the expected output, so the linear engine is
 * checked against it on many small random inputs.
 */
const REFERENCE_RULES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, R],
  [/orc_pat_[A-Za-z0-9_-]{43}/g, R],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, R],
  [/\b((?:password|passwd|pwd)\s*=\s*)\{(?:[^}]|\}\})*\}/gi, `$1${R}`],
  [
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi,
    `$1${R}`,
  ],
  [/\b(aws_secret_access_key\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi, `$1${R}`],
  [
    /("(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token)|pwd|api[_-]?key|apikey|authorization|cookie|private_?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${R}"`,
  ],
  [/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:)[^@\s]+@/gi, `$1${R}@`],
  [/((?:__Host-)?orc_sid=)[^;\s]+/g, `$1${R}`],
];

function referenceMask(text: string, registry?: SecretRegistry): string {
  let out = text;
  for (const value of registry?.values() ?? []) out = out.split(value).join(R);
  for (const [pattern, replacement] of REFERENCE_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS: readonly string[] = [
  'password',
  'Passwd',
  'pwd',
  'token',
  'secret',
  'api_key',
  'aws_secret_access_key',
  '=',
  ' = ',
  ':',
  ': ',
  '"',
  "'",
  '{',
  '}',
  '}}',
  '\\',
  '\\"',
  ';',
  ',',
  '&',
  ' ',
  '\n',
  '\r',
  '\t',
  'x',
  'abc',
  'A1',
  '-',
  '/',
  '//',
  '://',
  'http',
  'redis',
  '1a',
  '+',
  '.',
  '@',
  'user',
  'Bearer ',
  'basic ',
  'abcdefgh123',
  'sk-ant-',
  'AbCdEfGhIjKlMnOpQrStUv',
  'AKIA',
  'IOSFODNN7EXAMPLE',
  'ghp_',
  'xoxb-',
  'github_pat_',
  '"password"',
  '"access_token"',
  '"api-key"',
  '"cookie"',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----END RSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----',
  'orc_sid=',
  '__Host-orc_sid=',
  'registered-secret-01',
];

function randomText(next: () => number, maxFragments: number): string {
  const count = 1 + Math.floor(next() * maxFragments);
  let out = '';
  for (let i = 0; i < count; i += 1) out += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  return out;
}

function timed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function streamAll(
  text: string,
  chunkSize: number,
  registry?: SecretRegistry,
  maxHoldChars?: number,
): string {
  const masker = createStreamMasker(registry, maxHoldChars === undefined ? {} : { maxHoldChars });
  let out = '';
  for (let i = 0; i < text.length; i += chunkSize) out += masker.push(text.slice(i, i + chunkSize));
  return out + masker.flush();
}

describe('maskText is linear-time (regression: O(n^2) on long lines without separators)', () => {
  const registry = createSecretRegistry();
  registry.add('registered-secret-01');

  const ADVERSARIAL: readonly (readonly [string, string])[] = [
    ['1 MiB line of x', 'x'.repeat(MIB)],
    ['1 MiB scheme-like letters', 'a'.repeat(MIB)],
    ['URL prefixes without @', 'a://b:'.repeat(MIB / 6)],
    ['unterminated quoted values', 'password="a '.repeat(MIB / 12)],
    ['unterminated braced values', 'pwd={'.repeat(MIB / 5)],
    ['unterminated JSON strings', `${'"token":"\\'.repeat(MIB / 10)}\n`],
    ['BEGIN markers without END', '-----BEGIN PRIVATE KEY-----'.repeat(MIB / 27)],
    ['long scheme before ://', `${'a'.repeat(MIB - 3)}://`],
    ['quote then identifier run', `"${'x'.repeat(MIB)}`],
    ['dash run after Slack prefix', `xoxb-${'-'.repeat(MIB)}`],
    ['quotes only', '"'.repeat(MIB)],
  ];

  it.each(ADVERSARIAL)('masks %s well under 1 s', (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(MIB - 16);
    const ms = timed(() => maskText(input, registry));
    expect(ms).toBeLessThan(1000);
  });

  it('streams a 1 MiB line of x in small chunks well under 1 s', () => {
    const line = 'x'.repeat(MIB);
    let out = '';
    const ms = timed(() => {
      out = streamAll(line, 7, registry);
    });
    expect(ms).toBeLessThan(1000);
    expect(out).toBe(line);
  });

  it('streams a 1 MiB single giant match in small chunks well under 1 s', () => {
    const line = `orc_sid=${'x'.repeat(MIB)}`;
    let out = '';
    const ms = timed(() => {
      out = streamAll(line, 13, registry);
    });
    expect(ms).toBeLessThan(1000);
    expect(out).toBe(`orc_sid=${R}`);
  });

  it('streams many lines inside an unterminated private-key block well under 1 s', () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${'QUJDREVGR0g=\n'.repeat(MIB / 13)}`;
    const ms = timed(() => {
      streamAll(text, 13, registry);
    });
    expect(ms).toBeLessThan(1000);
  });
});

describe('linear engine produces exactly the reference output', () => {
  it('matches the regex reference on 4000 random inputs', () => {
    const registry = createSecretRegistry();
    registry.add('registered-secret-01');
    const next = rng(0x5eed);
    for (let i = 0; i < 4000; i += 1) {
      const input = randomText(next, 40);
      const reg = i % 2 === 0 ? registry : undefined;
      expect(maskText(input, reg), JSON.stringify(input)).toBe(referenceMask(input, reg));
    }
  });

  it.each([
    ['ODBC braces with an even closing run', 'PWD={a}}b}};x', `PWD=${R};x`],
    ['ODBC braces closed by an odd run', 'pwd={a}}}; b}', `pwd=${R}; b}`],
    ['JSON escaped quote', '{"password":"a\\"b","x":1}', `{"password":"${R}","x":1}`],
    ['JSON string broken by a line end', '"token":"a\\\nb"', '"token":"a\\\nb"'],
    ['scheme digits only', '1://u:p@h', '1://u:p@h'],
    ['scheme with leading digits', '9a1+b://u:pw@h', `9a1+b://u:${R}@h`],
    ['two URLs back to back', 'http://u:p@http://v:q@h', `http://u:${R}@http://v:${R}@h`],
    ['unterminated quote falls back to unquoted', 'token="abc def', `token=${R} def`],
    ['quoted value across lines', 'secret="a\nb" x', `secret=${R} x`],
  ])('%s', (_name, input, expected) => {
    expect(referenceMask(input)).toBe(expected);
    expect(maskText(input)).toBe(expected);
  });
});

describe('stream masker keeps its guarantees with the linear engine', () => {
  const SECRET = 'S3cr3t-Value-For-Registry-0001';

  it('masks secrets split at every boundary of random chunkings of long lines', () => {
    const registry = createSecretRegistry();
    registry.add(SECRET);
    const next = rng(42);
    const pieces = [
      SECRET,
      'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'password=hunter2hunter2',
      'redis://:redis-pass-123@redis:6379',
    ];
    for (let round = 0; round < 40; round += 1) {
      let text = '';
      for (let i = 0; i < 30; i += 1) {
        text += 'y'.repeat(Math.floor(next() * 900));
        text += ` ${pieces[Math.floor(next() * pieces.length)]} `;
        if (next() < 0.2) text += '\n';
      }
      const chunk = 1 + Math.floor(next() * 300);
      const out = streamAll(text, chunk, registry, 2048);
      expect(out).not.toContain(SECRET.slice(0, 16));
      expect(out).not.toContain('hunter2');
      expect(out).not.toContain('redis-pass-123');
      expect(out).not.toContain('sk-ant-api03');
      expect(out.replaceAll(R, '')).toBe(
        maskText(text, registry).replaceAll(R, ''),
      );
    }
  });

  it('holds a private key whose BEGIN marker is split across chunks', () => {
    const key = [
      '-----BEGIN EC PRIVATE KEY-----',
      'MHcCAQEEIBexampleexampleexampleexampleexampleexampleoAoGCCqGSM49',
      'AwEHoUQDQgAEexampleexampleexampleexampleexampleexampleexample==',
      '-----END EC PRIVATE KEY-----',
    ].join('\n');
    const text = `start\n${key}\nend\n`;
    for (let split = 1; split < text.length; split += 3) {
      const masker = createStreamMasker();
      const out =
        masker.push(text.slice(0, split)) +
        [...text.slice(split)].map((c) => masker.push(c)).join('') +
        masker.flush();
      expect(out).toBe(`start\n${R}\nend\n`);
    }
  });

  it('never releases a line before its terminator and bounds the held tail', () => {
    const masker = createStreamMasker(undefined, { maxHoldChars: 4096 });
    let emitted = '';
    for (let i = 0; i < 100; i += 1) emitted += masker.push('z'.repeat(997));
    expect(masker.pendingChars).toBeLessThanOrEqual(4096 + 997);
    expect(emitted.length + masker.pendingChars).toBe(99_700);
    emitted += masker.flush();
    expect(emitted).toBe('z'.repeat(99_700));
  });
});
