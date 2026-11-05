import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_AUTH_MODES } from '@orc/shared';
import { CLAUDE_OAUTH_TOKEN_REGEX as SHARED_REGEX } from '@orc/shared/node';

interface Credentials {
  CLAUDE_AUTH_MODES: string[];
  CLAUDE_OAUTH_TOKEN_REGEX: RegExp;
  isOAuthToken: (v: string) => boolean;
  isApiKey: (v: string) => boolean;
  evaluateCredentials: (o: { mode: string; oauthToken: string; apiKey: string }) => string[];
}

const FAKE_TOKEN = `sk-ant-oat01-${'A'.repeat(40)}`;
const FAKE_KEY = `sk-ant-api03-${'k'.repeat(40)}`;
const load = async (): Promise<Credentials> =>
  (await import(pathToFileURL(join(__dirname, '..', '..', '..', 'scripts/lib/claude-credentials.mjs')).href)) as Credentials;

describe('scripts/lib/claude-credentials.mjs', () => {
  it('copies the @orc/shared regex and mode list verbatim', async () => {
    const lib = await load();
    expect(lib.CLAUDE_OAUTH_TOKEN_REGEX.source).toBe(SHARED_REGEX.source);
    expect(lib.CLAUDE_OAUTH_TOKEN_REGEX.flags).toBe(SHARED_REGEX.flags);
    expect(lib.CLAUDE_AUTH_MODES).toEqual([...CLAUDE_AUTH_MODES]);
  });

  it('recognises tokens and rejects API keys as tokens and vice versa', async () => {
    const lib = await load();
    expect(lib.isOAuthToken(FAKE_TOKEN)).toBe(true);
    expect(lib.isOAuthToken(FAKE_KEY)).toBe(false);
    expect(lib.isOAuthToken('sk-ant-oat01-short')).toBe(false);
    expect(lib.isApiKey(FAKE_KEY)).toBe(true);
    expect(lib.isApiKey(FAKE_TOKEN)).toBe(false);
    expect(lib.isApiKey('has space in it 12345678')).toBe(false);
  });

  it('requires exactly one non-empty credential that matches the mode', async () => {
    const { evaluateCredentials: ev } = await load();
    expect(ev({ mode: 'oauth', oauthToken: FAKE_TOKEN, apiKey: '' })).toEqual([]);
    expect(ev({ mode: 'api_key', oauthToken: '', apiKey: FAKE_KEY })).toEqual([]);
    expect(ev({ mode: 'oauth', oauthToken: '', apiKey: '' })).toHaveLength(1);
    expect(ev({ mode: 'api_key', oauthToken: '', apiKey: '' })).toHaveLength(1);
    expect(ev({ mode: 'oauth', oauthToken: FAKE_TOKEN, apiKey: FAKE_KEY }).join()).toMatch(/both set/);
    expect(ev({ mode: 'oauth', oauthToken: '', apiKey: FAKE_KEY }).join()).toMatch(/only anthropic_api_key/);
    expect(ev({ mode: 'api_key', oauthToken: FAKE_TOKEN, apiKey: '' }).join()).toMatch(/only claude_oauth_token/);
    expect(ev({ mode: 'oauth', oauthToken: 'sk-ant-oat01-x', apiKey: '' }).join()).toMatch(/REGEX/);
    expect(ev({ mode: 'api_key', oauthToken: '', apiKey: FAKE_TOKEN }).join()).toMatch(/OAuth token/);
    expect(ev({ mode: 'bogus', oauthToken: FAKE_TOKEN, apiKey: '' })).toHaveLength(1);
  });

  it('never puts a credential value into a message', async () => {
    const { evaluateCredentials: ev } = await load();
    const text = [
      ...ev({ mode: 'oauth', oauthToken: FAKE_TOKEN, apiKey: FAKE_KEY }),
      ...ev({ mode: 'api_key', oauthToken: FAKE_TOKEN, apiKey: FAKE_TOKEN }),
    ].join('\n');
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_KEY);
  });
});
