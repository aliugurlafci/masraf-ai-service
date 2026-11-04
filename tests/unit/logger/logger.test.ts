import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACT_PATHS, serializeError } from '@orc/logger';
import type { LoggerOptions } from '@orc/logger';
import { createSecretRegistry } from '@orc/security';
import type { SecretRegistry } from '@orc/security';

const R = '[REDACTED]';
const ANTHROPIC_KEY = `sk-ant-api03-${'x'.repeat(40)}`;

type LogRecord = Record<string, unknown>;

function capture(overrides: Partial<LoggerOptions> = {}, secrets?: SecretRegistry) {
  let buffer = '';
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    version: '1.2.3',
    env: 'test',
    destination,
    secrets,
    ...overrides,
  });
  const records = (): LogRecord[] =>
    buffer
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogRecord);
  return { logger, records, raw: () => buffer };
}

function last(records: LogRecord[]): LogRecord {
  const record = records.at(-1);
  if (!record) throw new Error('no log record captured');
  return record;
}

describe('createLogger', () => {
  it('writes JSON lines with ISO time, level label and base fields', () => {
    const { logger, records } = capture();
    logger.info('hello');
    const rec = last(records());
    expect(rec).toMatchObject({
      level: 'info',
      service: 'test',
      env: 'test',
      version: '1.2.3',
      pid: process.pid,
      msg: 'hello',
    });
    expect(typeof rec.hostname).toBe('string');
    expect(rec.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('respects the configured level', () => {
    const { logger, records } = capture({ level: 'warn' });
    logger.info('dropped');
    logger.warn('kept');
    expect(records().map((r) => r.msg)).toEqual(['kept']);
  });

  it('redacts contract paths and nested secret keys at any depth', () => {
    const { logger, records, raw } = capture();
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer abcdefghijkl',
            cookie: 'orc_sid=abc',
            'x-csrf-token': 'csrf-value',
            accept: 'json',
          },
        },
        res: { headers: { 'set-cookie': 'orc_sid=new' } },
        user: { name: 'bob', password: 'pw-1', passwordHash: 'scrypt$1$...' },
        config: {
          db: { password: 'db-pw', host: 'mssql' },
          redis: { password: 'redis-pw' },
          anthropicApiKey: 'k',
        },
        deep: {
          a: {
            b: {
              c: { apiKey: 'deep-key', client_secret: 'cs', refresh_token: 'rt', keep: 'visible' },
            },
          },
        },
        list: [{ token: 'list-token' }],
      },
      'request',
    );
    const rec = last(records());
    expect(rec.req).toEqual({
      headers: { authorization: R, cookie: R, 'x-csrf-token': R, accept: 'json' },
    });
    expect(rec.res).toEqual({ headers: { 'set-cookie': R } });
    expect(rec.user).toEqual({ name: 'bob', password: R, passwordHash: R });
    expect(rec.config).toEqual({
      db: { password: R, host: 'mssql' },
      redis: { password: R },
      anthropicApiKey: R,
    });
    expect(rec.deep).toEqual({
      a: { b: { c: { apiKey: R, client_secret: R, refresh_token: R, keep: 'visible' } } },
    });
    expect(rec.list).toEqual([{ token: R }]);
    for (const leaked of [
      'pw-1',
      'db-pw',
      'redis-pw',
      'deep-key',
      'list-token',
      'csrf-value',
      'abcdefghijkl',
    ]) {
      expect(raw()).not.toContain(leaked);
    }
  });

  it('masks secret patterns in messages, interpolation arguments and string fields', () => {
    const { logger, records, raw } = capture();
    logger.info(`calling with ${ANTHROPIC_KEY}`);
    logger.info('conn %s', 'Server=db;Password=Hunter2Hunter2;');
    logger.info(
      { detail: `header Bearer ${'t'.repeat(20)}`, url: 'redis://:pw-in-url-1@redis:6379' },
      'fields',
    );
    const [a, b, c] = records();
    expect(a?.msg).toBe(`calling with ${R}`);
    expect(b?.msg).toBe(`conn Server=db;Password=${R};`);
    expect(c).toMatchObject({ detail: `header Bearer ${R}`, url: `redis://:${R}@redis:6379` });
    expect(raw()).not.toContain('Hunter2Hunter2');
    expect(raw()).not.toContain('pw-in-url-1');
  });

  it('masks dynamically registered secret values everywhere', () => {
    const secrets = createSecretRegistry();
    secrets.add('registered-db-password-123');
    const { logger, raw } = capture({}, secrets);
    logger.child({ component: 'db registered-db-password-123' }).error(
      {
        err: new Error('login failed for registered-db-password-123'),
        note: ['registered-db-password-123'],
      },
      'msg registered-db-password-123',
    );
    expect(raw()).not.toContain('registered-db-password-123');
    expect(raw()).toContain(R);
  });

  it('serializes errors with masked message and stack', () => {
    const { logger, records } = capture();
    const err = Object.assign(new Error(`upstream rejected key ${ANTHROPIC_KEY}`), {
      code: 'EAUTH',
    });
    logger.error({ err }, 'call failed');
    logger.error(new TypeError('password=letmein123 rejected'));
    const [first, second] = records();
    expect(first?.err).toMatchObject({
      type: 'Error',
      message: `upstream rejected key ${R}`,
      code: 'EAUTH',
    });
    expect(String((first?.err as LogRecord).stack)).not.toContain(ANTHROPIC_KEY);
    expect(second?.msg).toBe(`password=${R} rejected`);
    expect(second?.err).toMatchObject({ type: 'TypeError', message: `password=${R} rejected` });
  });

  it('masks child logger bindings', () => {
    const { logger, records } = capture();
    logger.child({ token: 'child-token-value', component: 'git' }).info('child');
    const rec = last(records());
    expect(rec).toMatchObject({ component: 'git', token: R, msg: 'child' });
  });

  it('ignores pretty outside development and when a destination is given', () => {
    const prod = capture({ pretty: true, env: 'production' });
    prod.logger.info('json');
    expect(last(prod.records())).toMatchObject({ msg: 'json', level: 'info' });
    const dev = capture({ pretty: true, env: 'development' });
    dev.logger.info('json too');
    expect(last(dev.records())).toMatchObject({ msg: 'json too', env: 'development' });
  });

  it('exports the contract redact paths', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.apiKey',
        'config.db.password',
        'config.redis.password',
        'config.anthropicApiKey',
      ]),
    );
  });
});

describe('serializeError', () => {
  it('serializes Error instances with type, masked message, code and stack', () => {
    const err = Object.assign(new RangeError('bad token=abc123456789'), { code: 'E_RANGE' });
    const out = serializeError(err);
    expect(out).toMatchObject({ type: 'RangeError', message: `bad token=${R}`, code: 'E_RANGE' });
    expect(out.stack).toContain('RangeError');
    expect(out.stack).not.toContain('abc123456789');
  });

  it('serializes non-Error values without throwing', () => {
    expect(serializeError('plain Bearer abcdefghijklmnop')).toEqual({
      type: 'string',
      message: `plain Bearer ${R}`,
    });
    expect(serializeError(null)).toEqual({ type: 'null', message: 'null' });
    expect(serializeError(undefined)).toEqual({ type: 'undefined', message: 'undefined' });
    expect(serializeError(42)).toEqual({ type: 'number', message: '42' });
    const obj = serializeError({ password: 'thrown-object-pw', reason: 'x' });
    expect(obj.type).toBe('Object');
    expect(obj.message).not.toContain('thrown-object-pw');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeError(circular)).not.toThrow();
  });
});
