// Excel import of a definition list (docs/onay-sistemi.md, section 6, "Excel içe aktarma"): which file
// column is which field, row checks, and what the import changes compared with the stored rows. Pure; the
// caller reads the file (src/excel/xlsx.ts) and writes the plan.
import { HttpError } from '../errors.ts';
import type { SheetRow } from '../excel/xlsx.ts';

export type Value = string | boolean | null;

export interface ImportField {
  /** API name: kod, ad, aciklama, paraBirimi, kdvOranlari, hesapKodu, simge, aktif. */
  readonly name: string;
  /** For messages: "Kod", "Organizasyon adı". */
  readonly label: string;
  readonly kind: 'text' | 'currency' | 'choice' | 'active';
  /** text: longest value. */
  readonly max?: number;
  /** text: may not be empty (the key, an organisation's name). */
  readonly required?: boolean;
  /** choice: the accepted values (lower case). */
  readonly choices?: readonly string[];
  /** choice: what a new row gets when the cell is empty. */
  readonly fallback?: string;
}

export interface ImportSpec {
  /** Name of the key field; the first entry of `fields`. */
  readonly key: string;
  /** "kod" or "ad", for "Bu kod dosyada 5. satırda da var." */
  readonly keyNoun: string;
  readonly fields: readonly ImportField[];
  /** Recognised headers and their field, in priority order: the first header that claims a name wins. */
  readonly headers: ReadonlyArray<readonly [header: string, field: string]>;
}

/** A stored row: its id and every field of the spec (aktif as boolean). */
export interface StoredRow {
  readonly id: number;
  readonly values: Readonly<Record<string, Value>>;
}

export interface RowError {
  readonly satir: number;
  readonly mesaj: string;
}

export interface ImportPlan {
  /** New rows, complete, in file order. */
  readonly inserts: ReadonlyArray<Readonly<Record<string, Value>>>;
  /** Changed rows with all their values after the import. */
  readonly updates: ReadonlyArray<{ readonly id: number; readonly values: Readonly<Record<string, Value>> }>;
  readonly unchanged: number;
  /** Active rows the file does not name, when asked to deactivate them. */
  readonly deactivate: readonly number[];
  readonly satirSayisi: number;
  /** Every erroneous row, by row number. */
  readonly errors: readonly RowError[];
  readonly sutunlar: Readonly<Record<string, string>>;
  readonly yokSayilanSutunlar: readonly string[];
}

/** The answer of an import (IceAktarim). */
export interface IceAktarim {
  readonly onizleme: boolean;
  readonly satirSayisi: number;
  readonly eklenen: number;
  readonly guncellenen: number;
  readonly degismeyen: number;
  readonly pasiflestirilen: number;
  readonly hataSayisi: number;
  readonly hatalar: readonly RowError[];
  readonly sutunlar: Readonly<Record<string, string>>;
  readonly yokSayilanSutunlar: readonly string[];
}

export const MAX_REPORTED_ERRORS = 100;

const invalid = (message: string): HttpError => new HttpError(400, 'gecersiz_dosya', message);

/** Headers compare without case, spaces, punctuation or Turkish letters: "Proje  Açıklaması" = "projeaciklamasi". */
export function normalizeHeader(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Codes and names compare like the database's Turkish case- and width-insensitive collation: compatibility
 * forms (full-width letters) are folded and invisible format characters are dropped.
 */
export const keyOf = (s: string): string => s.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLocaleUpperCase('tr-TR');

const TRUE_WORDS = new Set(['evet', 'e', 'aktif', '1', 'true', 'dogru']);
const FALSE_WORDS = new Set(['hayir', 'h', 'pasif', '0', 'false', 'yanlis']);

export function parseActive(cell: string): boolean | null {
  const word = normalizeHeader(cell);
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

/**
 * The option list's headers: A is the field's name, B the same without a trailing "Kodu" ("Proje Kodu" ->
 * "Proje"). "A Kodu" is "B Kodu" when A has no trailing "Kodu", and a doubled "Kodu" otherwise, so it is
 * not listed on its own.
 */
export function optionHeaders(fieldName: string): ImportSpec['headers'] {
  const a = fieldName.trim();
  const b = a.replace(/\s*kodu\s*$/iu, '').trim() || a;
  return [
    ['Kod', 'kod'],
    ['Ad', 'ad'],
    ['Açıklama', 'ad'],
    ['Aktif', 'aktif'],
    ['Durum', 'aktif'],
    [a, 'kod'],
    [`${a} Adı`, 'kod'],
    [`${b} Kodu`, 'kod'],
    [`${a} Açıklaması`, 'ad'],
    [`${b} Açıklaması`, 'ad'],
  ];
}

interface Columns {
  readonly index: ReadonlyMap<string, number>;
  readonly sutunlar: Record<string, string>;
  readonly yokSayilanSutunlar: string[];
}

function mapColumns(spec: ImportSpec, header: readonly string[]): Columns {
  const lookup = new Map<string, string>();
  for (const [h, field] of spec.headers) {
    const k = normalizeHeader(h);
    if (k !== '' && !lookup.has(k)) lookup.set(k, field);
  }
  const index = new Map<string, number>();
  const sutunlar: Record<string, string> = {};
  const yokSayilanSutunlar: string[] = [];
  header.forEach((cell, i) => {
    const text = cell.trim();
    if (text === '') return;
    const field = lookup.get(normalizeHeader(text));
    if (field === undefined || index.has(field)) {
      yokSayilanSutunlar.push(text);
      return;
    }
    index.set(field, i);
    sutunlar[field] = text;
  });
  if (!index.has(spec.key)) {
    const seen = new Set<string>();
    const names = spec.headers
      .filter(([h, f]) => f === spec.key && !seen.has(normalizeHeader(h)) && seen.add(normalizeHeader(h)))
      .map(([h]) => h);
    const label = spec.fields[0]?.label ?? spec.key;
    throw invalid(`Dosyada ${label.toLocaleLowerCase('tr-TR')} sütunu bulunamadı. Beklenen başlıklardan biri: ${names.join(', ')}.`);
  }
  return { index, sutunlar, yokSayilanSutunlar };
}

/** A row's cells for the columns in the file: string, boolean (aktif) or undefined (empty, "no change"). */
type Parsed = Record<string, Value | undefined>;

function parseCell(field: ImportField, raw: string, problems: string[]): Value | undefined {
  const cell = raw.trim();
  switch (field.kind) {
    case 'active': {
      if (cell === '') return undefined;
      const v = parseActive(cell);
      if (v === null) problems.push(`${field.label} değeri geçersiz: "${cell}" (Evet ya da Hayır yazın).`);
      return v ?? undefined;
    }
    case 'choice': {
      if (cell === '') return undefined;
      const v = normalizeHeader(cell);
      if (!(field.choices ?? []).includes(v)) {
        problems.push(`${field.label} geçersiz: "${cell}". Geçerli değerler: ${(field.choices ?? []).join(', ')}.`);
        return undefined;
      }
      return v;
    }
    case 'currency': {
      if (cell === '') return null;
      const v = cell.toUpperCase();
      if (!/^[A-Z]{3}$/.test(v)) {
        problems.push(`${field.label} geçersiz: "${cell}" (üç harfli ISO kodu olmalıdır, ör. TRY).`);
        return undefined;
      }
      return v;
    }
    case 'text': {
      if (cell === '') {
        if (field.required === true) problems.push(`${field.label} boş.`);
        return null;
      }
      if (field.max !== undefined && cell.length > field.max) {
        problems.push(`${field.label} en fazla ${field.max} karakter olabilir.`);
        return undefined;
      }
      return cell;
    }
  }
}

const same = (a: Value | undefined, b: Value | undefined): boolean => (a ?? null) === (b ?? null);

/**
 * What importing `rows` (the first one is the header) into a list holding `stored` would do. Rows are
 * matched by key without case (Turkish rules); erroneous rows are left out and reported.
 */
export function planImport(spec: ImportSpec, rows: readonly SheetRow[], stored: readonly StoredRow[], options: { readonly deactivateMissing: boolean }): ImportPlan {
  const [header, ...data] = rows;
  if (header === undefined) throw invalid('Dosya boş: başlık satırı bulunamadı.');
  const columns = mapColumns(spec, header.hucreler);
  const present = spec.fields.filter((f) => columns.index.has(f.name));

  const byKey = new Map<string, StoredRow>();
  for (const row of stored) {
    const k = keyOf(String(row.values[spec.key] ?? ''));
    if (!byKey.has(k)) byKey.set(k, row);
  }

  const errors: RowError[] = [];
  const firstRow = new Map<string, number>();
  const named = new Set<string>();
  const inserts: Array<Record<string, Value>> = [];
  const updates: Array<{ id: number; values: Record<string, Value> }> = [];
  let unchanged = 0;

  for (const row of data) {
    const problems: string[] = [];
    const parsed: Parsed = {};
    for (const field of present) parsed[field.name] = parseCell(field, row.hucreler[columns.index.get(field.name) ?? -1] ?? '', problems);
    const key = parsed[spec.key];
    if (typeof key === 'string') {
      const k = keyOf(key);
      named.add(k);
      const first = firstRow.get(k);
      if (first !== undefined) problems.unshift(`Bu ${spec.keyNoun} dosyada ${first}. satırda da var.`);
      else firstRow.set(k, row.satir);
    }
    const match = typeof key === 'string' ? byKey.get(keyOf(key)) : undefined;
    if (match === undefined && problems.length === 0) {
      // A new row needs every required field, even one the file has no column for.
      for (const f of spec.fields) if (f.required === true && !columns.index.has(f.name)) problems.push(`${f.label} boş.`);
    }
    if (problems.length > 0) {
      errors.push({ satir: row.satir, mesaj: problems.join(' ') });
      continue;
    }
    if (match === undefined) {
      const values: Record<string, Value> = {};
      for (const f of spec.fields) {
        const v = parsed[f.name];
        values[f.name] = v !== undefined ? v : f.kind === 'active' ? true : f.kind === 'choice' ? (f.fallback ?? null) : null;
      }
      inserts.push(values);
      continue;
    }
    const values: Record<string, Value> = { ...match.values };
    for (const f of present) {
      const v = parsed[f.name];
      if (v !== undefined) values[f.name] = v;
    }
    if (spec.fields.every((f) => same(values[f.name], match.values[f.name]))) unchanged++;
    else updates.push({ id: match.id, values });
  }

  // A file whose key column holds no usable key would deactivate the whole list.
  if (options.deactivateMissing && named.size === 0) {
    throw invalid(`Dosyada hiçbir satırda ${spec.keyNoun} yok. Eksikleri pasifleştirmek bütün listeyi pasifleştirirdi; dosyayı kontrol edin.`);
  }
  const deactivate = options.deactivateMissing
    ? stored.filter((r) => r.values.aktif === true && !named.has(keyOf(String(r.values[spec.key] ?? '')))).map((r) => r.id)
    : [];
  return {
    inserts,
    updates,
    unchanged,
    deactivate,
    satirSayisi: data.length,
    errors,
    sutunlar: columns.sutunlar,
    yokSayilanSutunlar: columns.yokSayilanSutunlar,
  };
}

/** The IceAktarim answer of a plan. */
export function importResult(plan: ImportPlan, onizleme: boolean): IceAktarim {
  return {
    onizleme,
    satirSayisi: plan.satirSayisi,
    eklenen: plan.inserts.length,
    guncellenen: plan.updates.length,
    degismeyen: plan.unchanged,
    pasiflestirilen: plan.deactivate.length,
    hataSayisi: plan.errors.length,
    hatalar: plan.errors.slice(0, MAX_REPORTED_ERRORS),
    sutunlar: plan.sutunlar,
    yokSayilanSutunlar: plan.yokSayilanSutunlar,
  };
}
