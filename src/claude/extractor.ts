import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { DetectedFile } from './file-type.ts';
import { InvoiceSchema, invoiceJsonSchema, type Invoice } from './invoice-schema.ts';
import type { ClaudeOlcum } from './olcum.ts';

export type ExtractionErrorCode = 'claude_auth' | 'claude_limit' | 'claude_failed' | 'claude_timeout' | 'invalid_output';

export class ExtractionError extends Error {
  override readonly name = 'ExtractionError';
  readonly code: ExtractionErrorCode;
  constructor(code: ExtractionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Usage figures reported by the CLI in its result envelope. */
export interface ClaudeUsage {
  readonly apiSureMs: number | null;
  readonly tur: number | null;
  readonly girdiToken: number | null;
  readonly onbellektenToken: number | null;
  readonly onbellegeToken: number | null;
  readonly ciktiToken: number | null;
  readonly apiEsdegeriUsd: number | null;
  /** Model ids that served the run. */
  readonly modeller: readonly string[];
}

export interface ExtractorOptions {
  /** Claude Code CLI executable. */
  readonly claudeBin: string;
  /** Arguments placed before the CLI arguments (tests run a fake CLI through node). */
  readonly claudeArgsPrefix?: readonly string[];
  readonly model: string;
  /** Thinking effort; undefined leaves the CLI default. */
  readonly effort?: ClaudeEffort;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly oauthToken: string;
  /** Source of the few variables passed through to Claude. Defaults to process.env. */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export interface InvoiceFile {
  readonly buffer: Buffer;
  readonly type: DetectedFile;
}

export interface Extraction {
  readonly sonuc: Invoice;
  readonly olcum: ClaudeOlcum;
}

export type ExtractInvoice = (file: InvoiceFile) => Promise<Extraction>;

const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Variables Claude needs from the host. Everything else (API keys, user secrets) stays out. */
const PASS_THROUGH_ENV = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'ProgramFiles',
  'ProgramData',
  'TEMP',
  'TMP',
  'LANG',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function buildPrompt(fileName: string): string {
  return [
    `Çalışma dizinindeki "${fileName}" dosyası bir faturadır. Read aracıyla dosyayı oku.`,
    'Fatura başlığını ve faturadaki tüm kalemleri verilen JSON şemasına göre çıkar.',
    'Kurallar:',
    '- Faturada bulunmayan ya da okunamayan alan için null kullan; tahmin etme.',
    '- Tarih YYYY-MM-DD biçiminde olsun.',
    '- Tutarlar ve miktarlar ondalık ayracı nokta olan sayı (number) olsun; binlik ayraç ve para simgesi kullanma.',
    '- kdvOrani yüzde değeridir (ör. %20 için 20).',
    '- paraBirimi ISO 4217 kodu olsun (TL veya ₺ için TRY).',
    '- Dosya bir fatura değilse kalemler boş dizi, tüm başlık alanları null olsun.',
  ].join('\n');
}

export function buildClaudeArgs(model: string, fileName: string, effort?: ClaudeEffort): string[] {
  return [
    '-p',
    buildPrompt(fileName),
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(invoiceJsonSchema()),
    '--model',
    model,
    ...(effort !== undefined ? ['--effort', effort] : []),
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    // Every run uses a new temp cwd; moving per-machine sections out of the system
    // prompt keeps it identical across runs, so the prompt cache can be reused.
    '--exclude-dynamic-system-prompt-sections',
    '--no-session-persistence',
    '--settings',
    JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, includeGitInstructions: false }),
  ];
}

/**
 * Claude runs with an empty, throw-away config directory so the user's own hooks,
 * plugins, MCP servers and CLAUDE.md files never load. Authentication is the
 * subscription token from `claude setup-token`.
 */
export function buildClaudeEnv(base: NodeJS.ProcessEnv, home: string, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH_ENV) {
    const value = base[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

const ResultEnvelopeSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    api_error_status: z.number().nullable().optional(),
  })
  .passthrough();

const AUTH_MESSAGE =
  'Claude oturumu doğrulanamadı. Token süresi dolmuş veya iptal edilmiş olabilir: "claude setup-token" ile yenileyin.';

const AUTH_HINT =
  /not logged in|\/login|authenticat|unauthori[sz]ed|\b401\b|oauth|invalid api key|invalid (?:bearer )?token|token (?:has )?(?:expired|been revoked)/i;

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/** Turns the CLI's `--output-format json` result into a validated invoice. */
export function parseClaudeOutput(stdout: string): Invoice {
  let envelopeRaw: unknown;
  try {
    envelopeRaw = JSON.parse(stdout.trim());
  } catch {
    throw new ExtractionError('claude_failed', 'Claude çıktısı JSON değil.');
  }
  const envelope = ResultEnvelopeSchema.safeParse(envelopeRaw);
  if (!envelope.success) throw new ExtractionError('claude_failed', 'Claude çıktısı beklenen biçimde değil.');
  const { is_error: isError, result, structured_output: structured, subtype, api_error_status: apiStatus } = envelope.data;
  if (isError === true || (subtype !== undefined && subtype !== 'success')) {
    const message = result ?? subtype ?? 'bilinmeyen hata';
    if (apiStatus === 401 || apiStatus === 403 || (apiStatus == null && AUTH_HINT.test(message))) {
      throw new ExtractionError('claude_auth', AUTH_MESSAGE);
    }
    if (apiStatus === 429) {
      throw new ExtractionError('claude_limit', `Claude abonelik kullanım limitine ulaşıldı; bir süre sonra tekrar deneyin. (${message.slice(0, 200)})`);
    }
    throw new ExtractionError('claude_failed', `Claude hata döndürdü: ${message.slice(0, 300)}`);
  }
  let candidate: unknown = structured;
  if (candidate === undefined || candidate === null) {
    if (result === undefined) throw new ExtractionError('invalid_output', 'Claude sonuç döndürmedi.');
    try {
      candidate = JSON.parse(stripFences(result));
    } catch {
      throw new ExtractionError('invalid_output', 'Claude sonucu JSON olarak çözümlenemedi.');
    }
  }
  const invoice = InvoiceSchema.safeParse(candidate);
  if (!invoice.success) {
    const detail = invoice.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(kök)'}: ${i.message}`)
      .join('; ');
    throw new ExtractionError('invalid_output', `Claude sonucu fatura şemasına uymuyor: ${detail}`);
  }
  return invoice.data;
}

const UsageSchema = z
  .object({
    duration_api_ms: z.number().optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const NO_USAGE: ClaudeUsage = {
  apiSureMs: null,
  tur: null,
  girdiToken: null,
  onbellektenToken: null,
  onbellegeToken: null,
  ciktiToken: null,
  apiEsdegeriUsd: null,
  modeller: [],
};

/** Reads timing and token counts from the result envelope; missing fields become null. */
export function readClaudeUsage(stdout: string): ClaudeUsage {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return NO_USAGE;
  }
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success) return NO_USAGE;
  const m = parsed.data;
  return {
    apiSureMs: m.duration_api_ms ?? null,
    tur: m.num_turns ?? null,
    girdiToken: m.usage?.input_tokens ?? null,
    onbellektenToken: m.usage?.cache_read_input_tokens ?? null,
    onbellegeToken: m.usage?.cache_creation_input_tokens ?? null,
    ciktiToken: m.usage?.output_tokens ?? null,
    apiEsdegeriUsd: m.total_cost_usd ?? null,
    modeller: Object.keys(m.modelUsage ?? {}),
  };
}

export function createSemaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runClaude(opts: ExtractorOptions, args: string[], cwd: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.claudeBin, [...(opts.claudeArgsPrefix ?? []), ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function createClaudeExtractor(opts: ExtractorOptions): ExtractInvoice {
  const limit = createSemaphore(opts.maxConcurrent);
  const redact = (text: string): string => text.split(opts.oauthToken).join('[gizli]');

  return (file) =>
    limit(async () => {
      const work = await mkdtemp(join(tmpdir(), 'fatura-'));
      try {
        const home = join(work, 'home');
        const input = join(work, 'girdi');
        await mkdir(join(home, '.claude'), { recursive: true });
        await mkdir(join(home, 'AppData', 'Roaming'), { recursive: true });
        await mkdir(join(home, 'AppData', 'Local'), { recursive: true });
        await mkdir(input);
        const fileName = `fatura.${file.type.ext}`;
        await writeFile(join(input, fileName), file.buffer);

        const env = buildClaudeEnv(opts.baseEnv ?? process.env, home, opts.oauthToken);
        const started = Date.now();
        let run: RunResult;
        try {
          run = await runClaude(opts, buildClaudeArgs(opts.model, fileName, opts.effort), input, env);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? 'hata';
          throw new ExtractionError(
            'claude_failed',
            `Claude CLI başlatılamadı (${code}). Claude Code kurulu mu ve PATH'te mi? Gerekirse CLAUDE_BIN ile yolunu verin.`,
          );
        }
        if (run.timedOut) {
          throw new ExtractionError('claude_timeout', `Claude ${Math.round(opts.timeoutMs / 1000)} saniyede yanıt vermedi.`);
        }
        if (run.stdout.trim() === '') {
          const reason = redact(run.stderr).trim().slice(0, 300);
          if (AUTH_HINT.test(reason)) throw new ExtractionError('claude_auth', AUTH_MESSAGE);
          throw new ExtractionError('claude_failed', `Claude çıktı üretmedi (çıkış kodu ${String(run.code)}): ${reason}`);
        }
        const sureMs = Date.now() - started;
        let sonuc: Invoice;
        try {
          sonuc = parseClaudeOutput(run.stdout);
        } catch (err) {
          if (err instanceof ExtractionError) throw new ExtractionError(err.code, redact(err.message));
          throw err;
        }
        const { modeller, ...usage } = readClaudeUsage(run.stdout);
        return {
          sonuc,
          olcum: {
            sureMs,
            ...usage,
            model: modeller.length > 0 ? modeller.join(', ') : opts.model,
            effort: opts.effort ?? null,
          },
        };
      } finally {
        await rm(work, { recursive: true, force: true, maxRetries: 3 });
      }
    });
}
