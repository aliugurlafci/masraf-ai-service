import { describe, expect, it } from 'vitest';
import {
  createSecretRegistry,
  generatePat,
  maskObject,
  maskText,
  REDACT_KEYS,
  SECRET_VALUE_PATTERNS,
} from '@orc/security';

const R = '[REDACTED]';
const ANTHROPIC_KEY = `sk-ant-api03-${'Ab1_-'.repeat(12)}`;
const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACDx2kZ9r5xGZ1yL1f5Yy7mJQK8z6m1Yc0dW0qH8eUu8wAAAJgmY2ZqJmNm',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('maskText vectors', () => {
  it.each([
    ['Anthropic API key', `using key ${ANTHROPIC_KEY} now`, ANTHROPIC_KEY, `using key ${R} now`],
    [
      'bearer token',
      'Authorization: Bearer eyJhbGciOi.payload.sig-123',
      'eyJhbGciOi',
      `Authorization: Bearer ${R}`,
    ],
    [
      'basic auth',
      'authorization: basic dXNlcjpwYXNzd29yZA==',
      'dXNlcjpwYXNzd29yZA',
      `authorization: basic ${R}`,
    ],
    ['AWS access key id', 'aws AKIAIOSFODNN7EXAMPLE end', 'AKIAIOSFODNN7EXAMPLE', `aws ${R} end`],
    [
      'AWS secret access key',
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'wJalrXUtnFEMI',
      `aws_secret_access_key = ${R}`,
    ],
    ['GitHub classic token', `ghp_${'a1B2'.repeat(9)}`, 'ghp_a1B2', R],
    [
      'GitHub fine-grained token',
      `github_pat_${'11ABCDEFG0'.repeat(4)}_xyz`,
      'github_pat_11ABC',
      R,
    ],
    ['GitHub server token', `token ghs_${'Z'.repeat(40)}`, 'ghs_ZZZ', `token ${R}`],
    ['Slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890', R],
    [
      'MSSQL connection string password',
      'Server=mssql,1433;Database=orc;User Id=orc_api;Password=S3cr3t!Pass#1;Encrypt=true',
      'S3cr3t!Pass#1',
      `Server=mssql,1433;Database=orc;User Id=orc_api;Password=${R};Encrypt=true`,
    ],
    [
      'ODBC braced password',
      'Driver=x;PWD={se;cr}}et};Server=db',
      'cr}}et',
      `Driver=x;PWD=${R};Server=db`,
    ],
    ['key=value secret', 'api_key=abc123def456&user=bob', 'abc123def456', `api_key=${R}&user=bob`],
    ['quoted token', 'token: "quoted secret value"', 'quoted secret', `token: ${R}`],
    [
      'JSON password',
      '{"password":"hunter2hunter2","user":"bob"}',
      'hunter2',
      `{"password":"${R}","user":"bob"}`,
    ],
    ['JSON access_token', '{"access_token": "abc.def.ghi"}', 'abc.def', `{"access_token": "${R}"}`],
    [
      'URL credentials',
      'mssql://sa:pa55w0rd@db:1433/orc',
      'pa55w0rd',
      `mssql://sa:${R}@db:1433/orc`,
    ],
    [
      'Redis URL without user',
      'redis://:redis-pass-123@redis:6379',
      'redis-pass-123',
      `redis://:${R}@redis:6379`,
    ],
    [
      'session cookie',
      'Cookie: __Host-orc_sid=abcDEF123_-xyz; theme=dark',
      'abcDEF123',
      `Cookie: __Host-orc_sid=${R}; theme=dark`,
    ],
    ['dev session cookie', 'orc_sid=abcdef0123456789', 'abcdef0123', `orc_sid=${R}`],
    ['private key block', `key:\n${PRIVATE_KEY}\ndone`, 'b3BlbnNzaC1rZXkt', `key:\n${R}\ndone`],
  ])('masks %s', (_name, input, leaked, expected) => {
    const out = maskText(input);
    expect(out).not.toContain(leaked);
    expect(out).toBe(expected);
  });

  it('masks a generated personal access token', () => {
    const { token } = generatePat();
    expect(maskText(`Authorization header was ${token}`)).toBe(`Authorization header was ${R}`);
  });

  it.each([
    ['plain text', 'hello world'],
    ['token counts', 'output_tokens: 1234, tokens used: 99'],
    ['short bearer word', 'Bearer abc'],
    ['URL without credentials', 'https://api.anthropic.com/v1/messages'],
    ['git sha', 'commit 3f2c1a9b8e7d6c5b4a39281706f5e4d3c2b1a090'],
  ])('leaves %s untouched', (_name, input) => {
    expect(maskText(input)).toBe(input);
  });

  it('is idempotent and stable across repeated calls (global regex state)', () => {
    const input = `a ${ANTHROPIC_KEY} b password=xyz123456 c`;
    const once = maskText(input);
    expect(maskText(once)).toBe(once);
    for (let i = 0; i < 3; i += 1) expect(maskText(input)).toBe(once);
  });

  it('exports global patterns only', () => {
    expect(SECRET_VALUE_PATTERNS.length).toBeGreaterThanOrEqual(10);
    for (const pattern of SECRET_VALUE_PATTERNS) expect(pattern.flags).toContain('g');
  });
});

describe('SecretRegistry (dynamic secret values)', () => {
  it('masks registered values verbatim, longest first, and their URL-encoded form', () => {
    const registry = createSecretRegistry();
    registry.add('db-pass-0123456789');
    registry.add('db-pass-0123');
    registry.add('p@ss w0rd!!x');
    const out = maskText(
      'a db-pass-0123456789 b db-pass-0123 c p%40ss%20w0rd!!x d p@ss w0rd!!x',
      registry,
    );
    expect(out).toBe(`a ${R} b ${R} c ${R} d ${R}`);
  });

  describe('encoded variants (ADR-0036 m.8: a credential inside an encoded payload)', () => {
    const SECRET = 'credprobe.UNIT.5e1c9a7f3b2d8064aa1f.reg';
    const b64 = (s: string, enc: 'base64' | 'base64url' = 'base64'): string => Buffer.from(s, 'utf8').toString(enc);
    /** Base64 groups that lie entirely inside the secret: present in any encoding of it at that alignment. */
    const groupCore = (offset: number, enc: 'base64' | 'base64url'): string => {
      const bytes = Buffer.from(SECRET, 'utf8');
      const encoded = Buffer.concat([Buffer.alloc(offset, 0x78), bytes]).toString(enc);
      return encoded.slice(Math.ceil(offset / 3) * 4, Math.floor((offset + bytes.length) / 3) * 4);
    };

    it.each(['', 'x', 'xy', 'xyz', '{"chunk":"', 'stdout: line 1\n'])(
      'masks the base64/base64url form behind the prefix %j, keeping the surrounding text',
      (prefix) => {
        const registry = createSecretRegistry();
        registry.add(SECRET);
        for (const enc of ['base64', 'base64url'] as const) {
          const encoded = b64(`${prefix}${SECRET}\n-- trailing bytes`, enc);
          const out = maskText(`before ${encoded} after`, registry);
          expect(out).toContain(R);
          expect(out.startsWith('before ')).toBe(true);
          expect(out.endsWith(' after')).toBe(true);
          for (const offset of [0, 1, 2]) expect(out, `${enc}@${offset}`).not.toContain(groupCore(offset, enc));
        }
      },
    );

    it('masks the full base64 form, hex (both cases) and the JSON-escaped form', () => {
      const registry = createSecretRegistry();
      const quoted = 'with "quotes" and \\ backslash 0123';
      registry.add(SECRET);
      registry.add(quoted);
      const hex = Buffer.from(SECRET, 'utf8').toString('hex');
      const escaped = JSON.stringify(quoted).slice(1, -1);
      const out = maskText(`a ${b64(SECRET)} b ${hex} c ${hex.toUpperCase()} d ${escaped} e`, registry);
      expect(out).toBe(`a ${R} b ${R} c ${R} d ${R} e`);
    });

    it('registers no encoded form below 16 characters (no masking of short base64 runs)', () => {
      const registry = createSecretRegistry();
      registry.add('abcdefgh');
      for (const v of registry.values()) expect(v.length === 8 || v.length >= 16, v).toBe(true);
      expect(registry.values()).not.toContain(b64('abcdefgh'));
      expect(maskText(`x ${b64('abcdefgh')} y`, registry)).toBe(`x ${b64('abcdefgh')} y`);
      // Unrelated base64 stays untouched.
      const unrelated = b64('a completely unrelated payload of some length');
      registry.add(SECRET);
      expect(maskText(unrelated, registry)).toBe(unrelated);
    });

    it('re-registering a value or its own base64 (as createClaudeRunner does) is harmless', () => {
      const registry = createSecretRegistry();
      registry.add(SECRET);
      const once = [...registry.values()];
      registry.add(SECRET);
      expect(registry.values()).toEqual(once);
      registry.add(b64(SECRET));
      registry.add(b64(SECRET));
      expect(new Set(registry.values()).size).toBe(registry.values().length);
      expect(maskText(`${SECRET} ${b64(SECRET)} ${b64(`x${SECRET}`)}`, registry)).not.toMatch(/[A-Za-z0-9+/]{16,}/);
    });
  });

  it('ignores values shorter than 8 characters and empty input', () => {
    const registry = createSecretRegistry();
    registry.add('short');
    registry.add(undefined);
    registry.add(null);
    registry.add('');
    expect(registry.values()).toEqual([]);
    expect(maskText('short text', registry)).toBe('short text');
  });
});

describe('maskObject', () => {
  it('redacts REDACT_KEYS at any depth (exact and suffix, case-insensitive) without mutating input', () => {
    const input = {
      user: 'bob',
      Password: 'p1',
      nested: {
        deeper: {
          apiKey: 'k1',
          API_KEY: 'k2',
          db_password: 'p2',
          refresh_token: 't1',
          client_secret: 's1',
          Authorization: 'Bearer abc',
          'Set-Cookie': 'orc_sid=1',
          privateKey: 'pk',
          connectionString: 'Server=x',
          note: `uses ${ANTHROPIC_KEY}`,
          count: 3,
          ok: true,
        },
      },
      list: [{ secret: 's2' }, 'Bearer abcdefghijklmnop', 7],
      password: null,
    };
    const snapshot = structuredClone(input);
    const out = maskObject(input);
    expect(input).toEqual(snapshot);
    expect(out).toEqual({
      user: 'bob',
      Password: R,
      nested: {
        deeper: {
          apiKey: R,
          API_KEY: R,
          db_password: R,
          refresh_token: R,
          client_secret: R,
          Authorization: R,
          'Set-Cookie': R,
          privateKey: R,
          connectionString: R,
          note: `uses ${R}`,
          count: 3,
          ok: true,
        },
      },
      list: [{ secret: R }, `Bearer ${R}`, 7],
      password: null,
    });
  });

  it('handles circular references, dates, errors and registry values', () => {
    const registry = createSecretRegistry();
    registry.add('registered-secret-1');
    const when = new Date('2026-11-02T10:00:00.000Z');
    const node: Record<string, unknown> = { name: 'registered-secret-1 here', when };
    node.self = node;
    node.err = new Error('failed with password=hunter2hunter2');
    const out = maskObject(node, registry);
    expect(out.name).toBe(`${R} here`);
    expect(out.self).toBe('[Circular]');
    expect(out.when).toEqual(when);
    expect(out.when).not.toBe(when);
    expect(out.err).toMatchObject({ name: 'Error', message: `failed with password=${R}` });
  });

  it('masks plain strings directly', () => {
    expect(maskObject(`k ${ANTHROPIC_KEY}`)).toBe(`k ${R}`);
  });

  it('REDACT_KEYS lists the contract key names', () => {
    expect(REDACT_KEYS).toEqual(
      expect.arrayContaining([
        'password',
        'token',
        'secret',
        'apikey',
        'api_key',
        'authorization',
        'cookie',
        'set-cookie',
        'privatekey',
      ]),
    );
  });
});
