import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ClaudeEffort } from './claude-extractor.ts';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TOKEN_FILE = resolve(ROOT_DIR, 'secrets', 'claude_oauth_token.txt');
export const OAUTH_TOKEN_REGEX = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/;
export const MODEL_NAME_REGEX = /^[A-Za-z0-9._[\]-]+$/;

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLAUDE_BIN: z.string().min(1).default('claude'),
  // A cascade, cheapest first: the next model reads only when the checks find a problem. On the user's
  // scanned invoices haiku misread amounts and opus misread the fewest digits (npm run karsilastir, 2026-11-06).
  CLAUDE_MODEL: z
    .string()
    .default('haiku,opus')
    .transform((s) => s.split(',').map((m) => m.trim()))
    .pipe(z.array(z.string().regex(MODEL_NAME_REGEX)).min(1).max(4)),
  // Reading an invoice needs little reasoning; "default" leaves the CLI's own setting.
  CLAUDE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).default('low'),
  CLAUDE_TIMEOUT_SEC: z.coerce.number().int().min(10).max(900).default(180),
  CLAUDE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(8).default(2),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_OAUTH_TOKEN_FILE: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).optional(),
  MAX_FILE_MB: z.coerce.number().int().min(1).max(32).default(20),
});

export interface AppConfig {
  readonly port: number;
  readonly claudeBin: string;
  /** Models in cascade order; usually one or two. */
  readonly claudeModels: readonly string[];
  readonly claudeEffort: ClaudeEffort | undefined;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly oauthToken: string;
  readonly dataDir: string;
  readonly maxFileBytes: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(
        `Claude token dosyası bulunamadı: ${path}. Komut satırında "claude setup-token" çalıştırıp çıkan token'ı bu dosyaya tek satır olarak kaydedin.`,
      );
    }
    throw new ConfigError(`Claude token dosyası okunamadı: ${path} (${code ?? 'bilinmeyen hata'})`);
  }
}

/** Reads the environment. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Geçersiz yapılandırma: ${detail}`);
  }
  const e = parsed.data;
  const inline = e.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const token = inline !== undefined && inline !== '' ? inline : readTokenFile(e.CLAUDE_OAUTH_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
  if (!OAUTH_TOKEN_REGEX.test(token)) {
    throw new ConfigError(
      'Claude token biçimi geçersiz (sk-ant-oat ile başlamalı). "claude setup-token" ile yeni token alıp dosyaya kaydedin.',
    );
  }
  return {
    port: e.PORT,
    claudeBin: e.CLAUDE_BIN,
    claudeModels: e.CLAUDE_MODEL,
    claudeEffort: e.CLAUDE_EFFORT === 'default' ? undefined : e.CLAUDE_EFFORT,
    timeoutMs: e.CLAUDE_TIMEOUT_SEC * 1000,
    maxConcurrent: e.CLAUDE_MAX_CONCURRENT,
    oauthToken: token,
    dataDir: resolve(ROOT_DIR, e.DATA_DIR ?? 'data/invoices'),
    maxFileBytes: e.MAX_FILE_MB * 1024 * 1024,
  };
}
