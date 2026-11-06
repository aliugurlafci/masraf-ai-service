import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, ROOT_DIR } from '../src/config.ts';
import { FAKE_TOKEN } from './helpers.ts';

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fatura-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies defaults', () => {
    const config = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    expect(config).toEqual({
      port: 4000,
      claudeBin: 'claude',
      claudeModels: ['haiku', 'opus'],
      claudeEffort: 'low',
      timeoutMs: 180_000,
      maxConcurrent: 2,
      oauthToken: FAKE_TOKEN,
      dataDir: join(ROOT_DIR, 'data', 'invoices'),
      maxFileBytes: 20 * 1024 * 1024,
    });
  });

  it('reads the token from a file and trims it', async () => {
    const file = join(dir, 'token.txt');
    await writeFile(file, `${FAKE_TOKEN}\r\n`);
    expect(loadConfig({ CLAUDE_OAUTH_TOKEN_FILE: file }).oauthToken).toBe(FAKE_TOKEN);
  });

  it('explains how to create a missing token file', () => {
    expect(() => loadConfig({ CLAUDE_OAUTH_TOKEN_FILE: join(dir, 'yok.txt') })).toThrow(/claude setup-token/);
  });

  it('rejects a malformed token without echoing it', () => {
    const bad = 'sk-ant-api03-this-is-an-api-key-not-oauth';
    let message = '';
    try {
      loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: bad });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/sk-ant-oat/);
    expect(message).not.toContain(bad);
  });

  it.each([
    ['PORT', '0'],
    ['CLAUDE_TIMEOUT_SEC', '5'],
    ['CLAUDE_MAX_CONCURRENT', '20'],
    ['MAX_FILE_MB', '100'],
    ['CLAUDE_MODEL', 'sonnet; rm -rf'],
    ['CLAUDE_MODEL', 'haiku,,opus'],
    ['CLAUDE_MODEL', 'a,b,c,d,e'],
    ['CLAUDE_EFFORT', 'fast'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, [key]: value })).toThrow(ConfigError);
  });

  it('reads CLAUDE_MODEL as a cascade, cheapest first', () => {
    const config = loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_MODEL: ' haiku , sonnet,opus ' });
    expect(config.claudeModels).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('accepts overrides', () => {
    const config = loadConfig({
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
      PORT: '4100',
      CLAUDE_MODEL: 'sonnet',
      CLAUDE_TIMEOUT_SEC: '300',
      DATA_DIR: dir,
      MAX_FILE_MB: '5',
    });
    expect(config).toMatchObject({ port: 4100, claudeModels: ['sonnet'], timeoutMs: 300_000, dataDir: dir, maxFileBytes: 5 * 1024 * 1024 });
  });

  it('maps CLAUDE_EFFORT=default to the CLI default', () => {
    expect(loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_EFFORT: 'default' }).claudeEffort).toBeUndefined();
    expect(loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, CLAUDE_EFFORT: 'high' }).claudeEffort).toBe('high');
  });
});
