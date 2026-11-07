import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  buildClaudeEnv,
  createClaudeExtractor,
  ExtractionError,
  parseClaudeOutput,
  readClaudeUsage,
  type ExtractorOptions,
} from '../../src/claude/extractor.ts';
import { invoiceJsonSchema } from '../../src/invoice/schema.ts';
import { FAKE_CLAUDE, FAKE_TOKEN, PDF_BYTES, sampleInvoice } from '../helpers.ts';

const PDF = { buffer: PDF_BYTES, type: { mime: 'application/pdf', ext: 'pdf' } } as const;

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs('sonnet', 'fatura.pdf');
  const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('allows only the Read tool and never bypasses permissions', () => {
    expect(valueOf('--tools')).toBe('Read');
    expect(valueOf('--allowedTools')).toBe('Read');
    expect(valueOf('--permission-mode')).toBe('dontAsk');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--strict-mcp-config');
  });

  it('passes the invoice JSON schema and JSON output format', () => {
    expect(valueOf('--output-format')).toBe('json');
    expect(JSON.parse(valueOf('--json-schema') ?? '')).toEqual(invoiceJsonSchema());
    expect(valueOf('--model')).toBe('sonnet');
    expect(valueOf('-p')).toContain('fatura.pdf');
  });

  it('disables hooks and memory through inline settings', () => {
    expect(JSON.parse(valueOf('--settings') ?? '')).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false });
  });

  it('keeps the system prompt cacheable and skips session files', () => {
    expect(args).toContain('--exclude-dynamic-system-prompt-sections');
    expect(args).toContain('--no-session-persistence');
  });

  it('passes the effort level only when one is set', () => {
    expect(args).not.toContain('--effort');
    const withEffort = buildClaudeArgs('sonnet', 'fatura.pdf', 'low');
    expect(withEffort[withEffort.indexOf('--effort') + 1]).toBe('low');
  });
});

describe('readClaudeUsage', () => {
  it('reads timing, token counts, API-equivalent cost and models', () => {
    const stdout = JSON.stringify({
      type: 'result',
      duration_ms: 9000,
      duration_api_ms: 8000,
      num_turns: 2,
      total_cost_usd: 0.021,
      usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 15000, cache_creation_input_tokens: 2000 },
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10 } },
    });
    expect(readClaudeUsage(stdout)).toEqual({
      apiSureMs: 8000,
      tur: 2,
      girdiToken: 10,
      onbellektenToken: 15000,
      onbellegeToken: 2000,
      ciktiToken: 300,
      apiEsdegeriUsd: 0.021,
      modeller: ['claude-sonnet-5-5'],
    });
  });

  it('tolerates missing fields and non-JSON output', () => {
    expect(readClaudeUsage('{}')).toMatchObject({ tur: null, girdiToken: null, modeller: [] });
    expect(readClaudeUsage('merhaba')).toMatchObject({ tur: null, apiEsdegeriUsd: null });
  });
});

describe('buildClaudeEnv', () => {
  it('keeps only allow-listed host variables and isolates the config dir', () => {
    const env = buildClaudeEnv(
      { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-api', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'x', TEMP: '' },
      '/w/home',
      FAKE_TOKEN,
    );
    expect(env.PATH).toBe('/bin');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('TEMP');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
    expect(env.HOME).toBe('/w/home');
    expect(env.USERPROFILE).toBe('/w/home');
    expect(env.CLAUDE_CONFIG_DIR).toBe(join('/w/home', '.claude'));
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
  });
});

describe('parseClaudeOutput', () => {
  const envelope = (fields: Record<string, unknown>): string =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields });

  it('reads structured_output', () => {
    expect(parseClaudeOutput(envelope({ result: '', structured_output: sampleInvoice() }))).toEqual(sampleInvoice());
  });

  it('falls back to fenced JSON in result', () => {
    const text = `Sonuç:\n\`\`\`json\n${JSON.stringify(sampleInvoice())}\n\`\`\``;
    expect(parseClaudeOutput(envelope({ result: text }))).toEqual(sampleInvoice());
  });

  it('falls back to plain JSON in result', () => {
    expect(parseClaudeOutput(envelope({ result: JSON.stringify(sampleInvoice()) }))).toEqual(sampleInvoice());
  });

  it.each([
    ['non-JSON stdout', 'merhaba', 'claude_failed'],
    ['error envelope', envelope({ is_error: true, result: 'overloaded' }), 'claude_failed'],
    ['error subtype', envelope({ subtype: 'error_max_turns' }), 'claude_failed'],
    ['auth error', envelope({ is_error: true, result: 'Invalid API key · Please run /login' }), 'claude_auth'],
    ['expired token', envelope({ is_error: true, result: 'OAuth token has expired' }), 'claude_auth'],
    [
      'real CLI 401 envelope',
      envelope({ is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }),
      'claude_auth',
    ],
    ['usage limit', envelope({ is_error: true, api_error_status: 429, result: 'rate_limit_error' }), 'claude_limit'],
    ['server error mentioning oauth', envelope({ is_error: true, api_error_status: 500, result: 'oauth service down' }), 'claude_failed'],
    ['no result', envelope({}), 'invalid_output'],
    ['result not JSON', envelope({ result: 'fatura bulunamadı' }), 'invalid_output'],
    ['schema mismatch', envelope({ structured_output: { fatura: {}, kalemler: [] } }), 'invalid_output'],
  ])('maps %s', (_name, stdout, code) => {
    expect(() => parseClaudeOutput(stdout)).toThrow(expect.objectContaining({ code }));
  });

  it('does not treat token-count errors as auth errors', () => {
    const stdout = envelope({ is_error: true, result: 'Prompt is too long: 250000 tokens' });
    expect(() => parseClaudeOutput(stdout)).toThrow(expect.objectContaining({ code: 'claude_failed' }));
  });
});

describe('createClaudeExtractor (fake CLI)', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fatura-test-'));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const extractor = (mode: string, overrides: Partial<ExtractorOptions> = {}) =>
    createClaudeExtractor({
      claudeBin: process.execPath,
      claudeArgsPrefix: [FAKE_CLAUDE, `--mode=${mode}`, `--dump=${join(scratch, 'dump.json')}`],
      model: 'sonnet',
      timeoutMs: 20_000,
      maxConcurrent: 2,
      oauthToken: FAKE_TOKEN,
      baseEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-must-not-leak', GITHUB_TOKEN: 'ghp_must_not_leak' },
      ...overrides,
    });

  const readDump = async (): Promise<{ args: string[]; env: Record<string, string>; cwd: string; files: string[] }> =>
    JSON.parse(await readFile(join(scratch, 'dump.json'), 'utf8'));

  it('returns the invoice from structured_output', async () => {
    const { sonuc } = await extractor('structured')(PDF);
    expect(sonuc).toMatchObject({
      fatura: { faturaNo: 'ABC2026000000123', genelToplam: 1800 },
      kalemler: [{ aciklama: 'Danışmanlık' }, { aciklama: 'Lisans' }],
    });
  });

  it('measures the run and passes the effort level', async () => {
    const { olcum } = await extractor('structured', { effort: 'low' })(PDF);
    expect(olcum).toEqual({
      sureMs: expect.any(Number),
      apiSureMs: 7400,
      tur: 2,
      girdiToken: 12,
      onbellektenToken: 15800,
      onbellegeToken: 0,
      ciktiToken: 420,
      apiEsdegeriUsd: 0.0312,
      model: 'claude-sonnet-5-5',
      effort: 'low',
    });
    expect(olcum.sureMs).toBeGreaterThan(0);
    const { args } = await readDump();
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('falls back to the configured model when the CLI reports none', async () => {
    const { olcum } = await extractor('result-text')(PDF);
    expect(olcum).toMatchObject({ model: 'sonnet', effort: null, tur: null });
  });

  it('returns the invoice from result text', async () => {
    const { sonuc } = await extractor('result-text')(PDF);
    expect(sonuc).toMatchObject({ fatura: { paraBirimi: 'TRY' } });
  });

  it('runs Claude in an isolated temp dir that holds only the invoice and is removed afterwards', async () => {
    await extractor('structured')(PDF);
    const dump = await readDump();
    expect(dump.files).toEqual(['fatura.pdf']);
    expect(dump.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
    expect(dump.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(dump.env).not.toHaveProperty('GITHUB_TOKEN');
    // process.cwd() in the child is the real path; on macOS the temp dir is a symlink
    // (/var → /private/var), so compare both in their real form.
    const realTmp = realpathSync(tmpdir());
    const configDir = dump.env.CLAUDE_CONFIG_DIR?.replace(tmpdir(), realTmp);
    expect(configDir?.startsWith(dirname(dump.cwd))).toBe(true);
    expect(dump.args).toContain('--json-schema');
    expect(existsSync(dirname(dump.cwd))).toBe(false);
  });

  it.each([
    ['bad-schema', 'invalid_output'],
    ['garbage', 'claude_failed'],
    ['auth-envelope', 'claude_auth'],
    ['auth-stderr', 'claude_auth'],
  ])('maps %s to %s and still cleans up', async (mode, code) => {
    await expect(extractor(mode)(PDF)).rejects.toMatchObject({ code });
    expect(existsSync(dirname((await readDump()).cwd))).toBe(false);
  });

  it('never puts the token in an error message', async () => {
    const err = await extractor('leak')(PDF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).message).not.toContain(FAKE_TOKEN);
    expect((err as ExtractionError).message).toContain('[gizli]');
  });

  it('kills a slow CLI and reports a timeout', async () => {
    await expect(extractor('slow', { timeoutMs: 1_000 })(PDF)).rejects.toMatchObject({ code: 'claude_timeout' });
  });

  it('reports a missing CLI binary', async () => {
    const run = extractor('structured', { claudeBin: join(scratch, 'yok', 'claude.exe'), claudeArgsPrefix: [] });
    await expect(run(PDF)).rejects.toMatchObject({ code: 'claude_failed', message: expect.stringContaining('CLAUDE_BIN') });
  });

  it('limits concurrent CLI runs', async () => {
    const one = extractor('slow', { timeoutMs: 1_500, maxConcurrent: 1 });
    const started = Date.now();
    const results = await Promise.allSettled([one(PDF), one(PDF)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    // Run one after the other: two timeouts in sequence, not in parallel.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  });
});
