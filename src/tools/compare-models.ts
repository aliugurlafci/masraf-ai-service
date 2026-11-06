// Compares Claude models on the user's own invoice files: how fast each one reads them and how often it
// agrees with the others. There is no answer key, so a field counts as correct when most models read the
// same value; every difference is listed so the user can check it against the file.
//
// Usage: npm run karsilastir -- <folder or file> [...] [--modeller "haiku,sonnet,opus,haiku>opus"]
// An entry such as "haiku>opus" is a cascade: the server's checks decide whether opus reads too.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createCascadeExtractor } from '../claude/cascade.ts';
import { createClaudeExtractor, ExtractionError, type ExtractInvoice } from '../claude/extractor.ts';
import { loadConfig, MODEL_NAME_REGEX } from '../config.ts';
import { detectFileType, type DetectedFile } from '../invoice/file-type.ts';
import type { Invoice } from '../invoice/schema.ts';

export const DEFAULT_MODELS: readonly string[] = ['haiku', 'sonnet', 'opus'];
export const CASCADE_SEPARATOR = '>';

export interface InputFile {
  readonly name: string;
  readonly buffer: Buffer;
  readonly type: DetectedFile;
}

export interface Attempt {
  readonly model: string;
  /** Model id the CLI reported for the alias; null when the read failed or for a cascade. */
  readonly surum: string | null;
  readonly sureMs: number;
  readonly sonuc: Invoice | null;
  readonly hata: string | null;
  readonly apiEsdegeriUsd: number | null;
  /** How many model reads it took (more than one when a cascade moved on). */
  readonly okumaSayisi: number;
}

export interface FileRun {
  readonly dosya: string;
  readonly denemeler: readonly Attempt[];
}

export interface ModelSummary {
  readonly model: string;
  readonly surum: string | null;
  readonly okunan: number;
  readonly hata: number;
  readonly medyanSureMs: number | null;
  readonly enUzunSureMs: number | null;
  readonly uyusanAlan: number;
  readonly toplamAlan: number;
  readonly tutmayanToplam: number;
  /** Sum over the successful reads; null when the CLI reported no cost. */
  readonly apiEsdegeriUsd: number | null;
  readonly yenidenOkunan: number;
}

export interface FieldDifference {
  readonly dosya: string;
  readonly alan: string;
  readonly degerler: ReadonlyMap<string, string>;
}

/** `key` is what gets compared; `shown` is what the report prints. */
interface Reading {
  readonly key: string;
  readonly shown: string;
}

const ABSENT: Reading = { key: '\u0000yok', shown: '(yok)' };

function reading(v: string | number | null): Reading {
  if (v === null) return { key: '\u0000bos', shown: '(boş)' };
  if (typeof v === 'number') return { key: v.toFixed(2), shown: String(v) };
  // Spacing, punctuation and case are not reading errors: "TAB.PİLİÇ CİĞER" equals "Tab Piliç Ciğer".
  return { key: v.normalize('NFC').toLocaleUpperCase('tr-TR').replace(/[^\p{L}\p{N}]/gu, ''), shown: v };
}

/** Flattens an invoice into field -> reading pairs, lines by position. */
export function flatten(inv: Invoice): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const [field, value] of Object.entries(inv.fatura)) out.set(`fatura.${field}`, reading(value));
  out.set('kalemSayisi', reading(inv.kalemler.length));
  inv.kalemler.forEach((line, i) => {
    for (const [field, value] of Object.entries(line)) out.set(`kalemler[${i}].${field}`, reading(value));
  });
  return out;
}

/** Same checks as the panel: line total vs subtotal, and subtotal + VAT vs grand total. */
export function totalsAgree(inv: Invoice): boolean {
  const f = inv.fatura;
  const lines = inv.kalemler;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(0.05, lines.length * 0.01);
  if (f.araToplam !== null && lines.length > 0 && lines.every((l) => l.tutar !== null)) {
    const sum = lines.reduce((acc, l) => acc + (l.tutar ?? 0), 0);
    if (!near(sum, f.araToplam) && !(f.genelToplam !== null && near(sum, f.genelToplam))) return false;
  }
  if (f.araToplam !== null && f.kdvToplam !== null && f.genelToplam !== null) {
    if (!near(f.araToplam + f.kdvToplam, f.genelToplam)) return false;
  }
  return true;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function summarize(
  runs: readonly FileRun[],
  models: readonly string[],
): { ozet: ModelSummary[]; farklar: FieldDifference[] } {
  const stats = new Map(
    models.map((m) => [
      m,
      {
        surum: null as string | null,
        times: [] as number[],
        usd: [] as number[],
        hata: 0,
        uyusan: 0,
        toplam: 0,
        tutmayan: 0,
        yeniden: 0,
      },
    ]),
  );
  const farklar: FieldDifference[] = [];

  for (const run of runs) {
    const flat = new Map<string, Map<string, Reading>>();
    for (const a of run.denemeler) {
      const s = stats.get(a.model);
      if (s === undefined) continue;
      if (a.sonuc === null) {
        s.hata++;
        continue;
      }
      s.times.push(a.sureMs);
      if (a.apiEsdegeriUsd !== null) s.usd.push(a.apiEsdegeriUsd);
      if (a.okumaSayisi > 1) s.yeniden++;
      s.surum ??= a.surum;
      if (!totalsAgree(a.sonuc)) s.tutmayan++;
      flat.set(a.model, flatten(a.sonuc));
    }

    const fields = new Set([...flat.values()].flatMap((m) => [...m.keys()]));
    for (const alan of fields) {
      const readings = new Map([...flat].map(([model, m]) => [model, m.get(alan) ?? ABSENT]));
      const counts = new Map<string, number>();
      for (const r of readings.values()) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
      const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      // A majority needs at least two models; with a tie or a single read the field proves nothing.
      const majority = n >= 2 && n * 2 > readings.size ? top : null;
      for (const [model, r] of readings) {
        const s = stats.get(model);
        if (s === undefined) continue;
        s.toplam++;
        if (r.key === majority) s.uyusan++;
      }
      if (counts.size > 1) {
        farklar.push({ dosya: run.dosya, alan, degerler: new Map([...readings].map(([m, r]) => [m, r.shown])) });
      }
    }
  }

  const ozet = models.map((model): ModelSummary => {
    const s = stats.get(model);
    return {
      model,
      surum: s?.surum ?? null,
      okunan: s?.times.length ?? 0,
      hata: s?.hata ?? 0,
      medyanSureMs: median(s?.times ?? []),
      enUzunSureMs: s !== undefined && s.times.length > 0 ? Math.max(...s.times) : null,
      uyusanAlan: s?.uyusan ?? 0,
      toplamAlan: s?.toplam ?? 0,
      tutmayanToplam: s?.tutmayan ?? 0,
      apiEsdegeriUsd: s !== undefined && s.usd.length > 0 ? s.usd.reduce((a, b) => a + b, 0) : null,
      yenidenOkunan: s?.yeniden ?? 0,
    };
  });
  return { ozet, farklar };
}

const seconds = (ms: number | null): string =>
  ms === null ? '-' : `${(ms / 1000).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} sn`;

export function formatReport(runs: readonly FileRun[], models: readonly string[], effort: string): string {
  const { ozet, farklar } = summarize(runs, models);
  const pct = (a: number, b: number): string => (b === 0 ? '-' : `%${Math.round((a / b) * 100)} (${a}/${b})`);
  const usd = (v: number | null): string =>
    v === null ? '-' : `$${v.toLocaleString('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  const rows = [
    ['Model', 'Okunan', 'Hata', 'Medyan süre', 'En uzun', 'Çoğunlukla aynı alan', 'Toplamı tutmayan', 'API karşılığı', 'Yeniden okunan'],
    ...ozet.map((s) => [
      s.surum !== null && s.surum !== s.model ? `${s.model} (${s.surum})` : s.model,
      String(s.okunan),
      String(s.hata),
      seconds(s.medyanSureMs),
      seconds(s.enUzunSureMs),
      pct(s.uyusanAlan, s.toplamAlan),
      String(s.tutmayanToplam),
      usd(s.apiEsdegeriUsd),
      String(s.yenidenOkunan),
    ]),
  ];
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  const lines = [
    `Effort: ${effort}, dosya: ${runs.length}`,
    '',
    ...rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join('  ').trimEnd()),
  ];
  const failed = runs.flatMap((r) => r.denemeler.filter((a) => a.hata !== null).map((a) => `  ${r.dosya}: ${a.model} (${a.hata})`));
  if (failed.length > 0) lines.push('', 'Okunamayanlar:', ...failed);
  if (farklar.length === 0) {
    if (failed.length === 0) lines.push('', 'Bütün modeller bütün alanları aynı okudu.');
    return lines.join('\n');
  }
  lines.push('', 'Modellerin farklı okuduğu alanlar (dosyayla karşılaştırın):');
  let current = '';
  for (const d of farklar) {
    if (d.dosya !== current) {
      lines.push(`  ${d.dosya}`);
      current = d.dosya;
    }
    const values = models.filter((m) => d.degerler.has(m)).map((m) => `${m}=${d.degerler.get(m) ?? ''}`);
    lines.push(`    ${d.alan}: ${values.join(', ')}`);
  }
  return lines.join('\n');
}

/** Reads every model on every file, one at a time so the timings do not disturb each other. */
export async function compareModels(
  files: readonly InputFile[],
  extractors: ReadonlyMap<string, ExtractInvoice>,
  log: (line: string) => void = () => {},
): Promise<FileRun[]> {
  const models = [...extractors.keys()];
  const total = files.length * models.length;
  let done = 0;
  const runs: FileRun[] = [];
  for (const [i, file] of files.entries()) {
    const denemeler: Attempt[] = [];
    // Rotate the order so the same model is not always the first run on a file.
    for (const model of models.map((_, j) => models[(i + j) % models.length] ?? '')) {
      const extract = extractors.get(model);
      if (extract === undefined) continue;
      const started = Date.now();
      let attempt: Attempt;
      let outcome: string;
      try {
        const { sonuc, olcum } = await extract({ buffer: file.buffer, type: file.type });
        const okumaSayisi = olcum.adimlar?.length ?? 1;
        attempt = {
          model,
          // A cascade's final model changes per file, so it has no single version to show.
          surum: model.includes(CASCADE_SEPARATOR) ? null : olcum.model,
          sureMs: olcum.sureMs,
          sonuc,
          hata: null,
          apiEsdegeriUsd: olcum.apiEsdegeriUsd,
          okumaSayisi,
        };
        outcome = okumaSayisi > 1 ? `${seconds(olcum.sureMs)} (${okumaSayisi} okuma, sonuç: ${olcum.model})` : seconds(olcum.sureMs);
      } catch (err) {
        // Without a working token or with the limit reached, the remaining reads would fail too.
        if (err instanceof ExtractionError && (err.code === 'claude_auth' || err.code === 'claude_limit')) throw err;
        const hata = err instanceof ExtractionError ? err.code : 'beklenmeyen_hata';
        attempt = {
          model,
          surum: null,
          sureMs: Date.now() - started,
          sonuc: null,
          hata,
          apiEsdegeriUsd: null,
          okumaSayisi: 0,
        };
        // Extractor messages are Turkish and already have the token masked.
        outcome = err instanceof ExtractionError ? `${hata}: ${err.message.slice(0, 160)}` : hata;
      }
      denemeler.push(attempt);
      done++;
      log(`[${done}/${total}] ${model.padEnd(8)} ${file.name}  ${outcome}`);
    }
    runs.push({ dosya: file.name, denemeler });
  }
  return runs;
}

/** Expands folders (not recursively) and keeps only files that are PDFs or images by content. */
export async function collectFiles(
  paths: readonly string[],
  maxBytes: number,
  log: (line: string) => void = () => {},
): Promise<InputFile[]> {
  const out: InputFile[] = [];
  for (const p of paths) {
    const info = await stat(p);
    const candidates = info.isDirectory()
      ? (await readdir(p, { withFileTypes: true }))
          .filter((e) => e.isFile())
          .map((e) => join(p, e.name))
          .sort()
      : [p];
    for (const path of candidates) {
      if ((await stat(path)).size > maxBytes) {
        log(`Atlandı, dosya çok büyük: ${path}`);
        continue;
      }
      const buffer = await readFile(path);
      const type = detectFileType(buffer);
      if (type === null) {
        log(`Atlandı, PDF ya da resim değil: ${path}`);
        continue;
      }
      out.push({ name: basename(path), buffer, type });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { modeller: { type: 'string' } } });
  if (positionals.length === 0) {
    console.error('Kullanım: npm run karsilastir -- <klasör veya dosya> [...] [--modeller "haiku,sonnet,opus,haiku>opus"]');
    process.exitCode = 2;
    return;
  }
  // "haiku > opus" and "haiku>opus" are the same entry.
  const models = [
    ...new Set(
      (values.modeller ?? DEFAULT_MODELS.join(','))
        .split(',')
        .map((entry) => entry.split(CASCADE_SEPARATOR).map((m) => m.trim()).join(CASCADE_SEPARATOR))
        .filter((entry) => entry !== ''),
    ),
  ];
  const bad = models.flatMap((entry) => entry.split(CASCADE_SEPARATOR)).find((m) => !MODEL_NAME_REGEX.test(m));
  if (models.length === 0 || bad !== undefined) {
    console.error(`Geçersiz model adı: ${bad || '(boş)'}`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const files = await collectFiles(positionals, config.maxFileBytes, (line) => console.log(line));
  if (files.length === 0) {
    console.error('Okunacak PDF ya da resim bulunamadı.');
    process.exitCode = 2;
    return;
  }
  console.log(
    `${files.length} dosya ve ${models.length} model: ${files.length * models.length} okuma yapılacak. Okumalar abonelik limitinizden düşer.`,
  );
  const single = (model: string): ExtractInvoice =>
    createClaudeExtractor({
      claudeBin: config.claudeBin,
      model,
      effort: config.claudeEffort,
      timeoutMs: config.timeoutMs,
      maxConcurrent: 1,
      oauthToken: config.oauthToken,
    });
  const extractors = new Map(
    models.map((entry): [string, ExtractInvoice] => {
      const parts = entry.split(CASCADE_SEPARATOR);
      if (parts.length === 1) return [entry, single(entry)];
      return [entry, createCascadeExtractor(parts.map((model) => ({ model, extract: single(model) })), 1)];
    }),
  );
  const runs = await compareModels(files, extractors, (line) => console.log(line));
  console.log(`\n${formatReport(runs, models, config.claudeEffort ?? 'CLI varsayılanı')}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
