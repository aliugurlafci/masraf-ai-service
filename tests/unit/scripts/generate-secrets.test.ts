import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../../helpers/common';

const ROOT = join(__dirname, '..', '..', '..');
const TOKEN = `sk-ant-oat01-${'A'.repeat(40)}`;
const KEY = `sk-ant-api03-${'k'.repeat(40)}`;

describe('scripts/generate-secrets.mjs Claude credentials (ADR-0036)', () => {
  const tmp = useTempDir();
  const run = (args: string[], input?: string, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ['scripts/generate-secrets.mjs', '--dir', tmp(), '--skip-certs', ...args], {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      shell: false,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const read = (name: string) => readFileSync(join(tmp(), `${name}.txt`), 'utf8');
  const size = (name: string) => statSync(join(tmp(), `${name}.txt`)).size;

  it('creates both credential files empty and explains how to supply the token', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(size('claude_oauth_token')).toBe(0);
    expect(size('anthropic_api_key')).toBe(0);
    expect(r.out).toContain('claude setup-token');
  });

  it('writes the token from stdin without echoing it and leaves the API key file empty', () => {
    const r = run(['--only', 'claude_oauth_token', '--claude-oauth-token-stdin'], `${TOKEN}\n`);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(TOKEN);
    expect(read('claude_oauth_token')).toBe(TOKEN);
    run([]);
    expect(size('anthropic_api_key')).toBe(0);
    expect(read('claude_oauth_token')).toBe(TOKEN);
  });

  it('rejects a malformed token and an API key given as a token', () => {
    expect(run(['--only', 'claude_oauth_token', '--claude-oauth-token-stdin'], 'sk-ant-oat01-short\n').status).toBe(1);
    expect(run(['--only', 'claude_oauth_token', '--claude-oauth-token-stdin'], `${KEY}\n`).status).toBe(1);
  });

  it('refuses to write one credential while the other file is non-empty', () => {
    run([]);
    writeFileSync(join(tmp(), 'anthropic_api_key.txt'), KEY);
    const r = run(['--only', 'claude_oauth_token', '--claude-oauth-token-stdin'], `${TOKEN}\n`);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain(KEY);
    expect(size('claude_oauth_token')).toBe(0);
  });

  it('ignores an ambient ANTHROPIC_API_KEY unless the secret is selected with --only', () => {
    run([], undefined, { ANTHROPIC_API_KEY: KEY });
    expect(size('anthropic_api_key')).toBe(0);
    run(['--only', 'anthropic_api_key'], undefined, { ANTHROPIC_API_KEY: KEY });
    expect(read('anthropic_api_key')).toBe(KEY);
  });
});
