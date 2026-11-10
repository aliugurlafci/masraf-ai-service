// Definition lists (docs/onay-sistemi.md, section 6, "Tanım listeleri"): organisations, cost centres, the
// options of 'liste' fields and, for Excel, the categories. Paged lists, edits and deletes, Excel export and
// import. Every write of a list holds that list's lock (list-tx.ts), so an import never overwrites an edit made
// after it read the list.
import { audit } from '../db/audit.ts';
import { execute, isUniqueViolation, p, query, queryOne, SQL_ERROR, sqlErrorNumber, transaction, type Db, type Executor, type Param } from '../db/sql.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import { readXlsx, writeXlsx } from '../excel/xlsx.ts';
import { ICONS } from '../expenses/categories.ts';
import type { Actor } from '../expenses/rules.ts';
import { display } from './display.ts';
import { importResult, optionHeaders, planImport, type IceAktarim, type ImportSpec, type StoredRow, type Value } from './excel-import.ts';
import { deleteRulesOf, lockList } from './list-tx.ts';

export interface Organizasyon {
  readonly id: number;
  readonly kod: string;
  readonly ad: string;
  readonly paraBirimi: string | null;
  readonly aktif: boolean;
  /** Active users in this organisation. */
  readonly kullaniciSayisi: number;
}

export interface MasrafMerkezi {
  readonly id: number;
  readonly kod: string;
  readonly aciklama: string | null;
  readonly gosterim: string;
  readonly aktif: boolean;
  /** Active users this cost centre is assigned to. */
  readonly kullaniciSayisi: number;
}

export interface Secenek {
  readonly id: number;
  readonly kod: string;
  readonly ad: string | null;
  readonly gosterim: string;
  readonly aktif: boolean;
  readonly sira: number;
}

/** A user's organisation as Kullanici carries it. */
export interface OrganizasyonOzet {
  readonly id: number;
  readonly kod: string;
  readonly ad: string;
  readonly aktif: boolean;
}

/** A cost centre as Kullanici and the forms carry it. */
export interface MasrafMerkeziOzet {
  readonly id: number;
  readonly kod: string;
  readonly aciklama: string | null;
  readonly gosterim: string;
  readonly aktif: boolean;
}

/** A 'liste' field whose options are a definition list. */
export interface ListeAlani {
  readonly id: number;
  readonly anahtar: string;
  readonly ad: string;
  readonly aktif: boolean;
}

export interface Sayfa<T> {
  readonly kayitlar: readonly T[];
  readonly toplam: number;
  readonly sayfa: number;
  readonly adet: number;
}

export interface ListFilter {
  readonly q?: string | undefined;
  readonly aktif?: boolean | undefined;
  readonly sayfa: number;
  readonly adet: number;
}

export interface ImportOptions {
  /** Nothing is written; the answer tells what would happen. */
  readonly preview: boolean;
  /** Active rows the file does not name become inactive. */
  readonly deactivateMissing: boolean;
}

export const MAX_IMPORT_ROWS = 20_000;
/** Inflated size of the sheet parts an import reads. A 20 000-row masraff.io export is about 20 MB; a larger
 * budget would only let a small upload block the event loop for longer. */
const MAX_IMPORT_INFLATED = 32 * 1024 * 1024;
/** SQL Server takes at most 2100 parameters per request and 1000 rows per VALUES list. */
const MAX_PARAMS = 2000;
const MAX_VALUES_ROWS = 1000;

interface Column {
  readonly name: string;
  readonly db: string;
  readonly param: (v: Value) => Param;
}

/** What Excel import and export need to know about a list. */
export interface ListDef {
  /** Lock resource, also the list's name in the audit log. */
  readonly lock: string;
  /** File and sheet name: "Masraf Merkezleri". */
  readonly title: string;
  readonly table: string;
  /** Options belong to one field. */
  readonly scope: { readonly column: string; readonly id: number } | null;
  /** Stored fields, the key first. */
  readonly columns: readonly Column[];
  /** New rows go after the last (MAX(sira) + 1, … in file order). */
  readonly sira: boolean;
  readonly spec: ImportSpec;
  readonly exportHeader: readonly string[];
  readonly exportRow: (v: Readonly<Record<string, Value>>) => string[];
  readonly exportOrder: string;
  /** Error of a key the table's unique index refuses. */
  readonly duplicate: () => HttpError;
}

/** Edits and the paged list of organisations, cost centres and options. */
export interface CrudDef<T> extends ListDef {
  /** Selects one record per row; the table's alias is x. */
  readonly select: string;
  readonly search: string;
  readonly pageOrder: string;
  readonly toRecord: (row: never) => T;
  /** Audit verbs: "<noun>_olusturuldu", "<noun>_guncellendi", "<noun>_silindi". */
  readonly noun: string;
  readonly describe: (r: T) => string;
  /** SQL answering `used` (1/0) for @id. */
  readonly inUse: string;
  readonly inUseMessage: string;
  /** Rules whose condition value is a row of this list: the condition field's key, its id, or none. */
  readonly ruleField: string | number | null;
  readonly notFoundMessage: string;
}

const textParam = (max: number) => (v: Value): Param => p.str(typeof v === 'string' ? v : null, max);
const ACTIVE: Column = { name: 'aktif', db: 'aktif', param: (v) => p.bit(v !== false) };
const cell = (v: Value | undefined): string => (typeof v === 'string' ? v : '');
const yesNo = (v: Value | undefined): string => (v === false ? 'Hayır' : 'Evet');
const codeTaken = (): HttpError => conflict('kod_kullaniliyor', 'Bu kod başka bir kayıtta kullanılıyor.');
const ACTIVE_HEADERS: ImportSpec['headers'] = [
  ['Aktif', 'aktif'],
  ['Durum', 'aktif'],
];

interface OrganizationRow {
  id: number;
  kod: string;
  ad: string;
  para_birimi: string | null;
  aktif: boolean;
  kullanici_sayisi: number;
}

export const ORGANIZATIONS: CrudDef<Organizasyon> = {
  lock: 'organizasyonlar',
  title: 'Organizasyonlar',
  table: 'dbo.organizasyonlar',
  scope: null,
  columns: [
    { name: 'kod', db: 'kod', param: textParam(50) },
    { name: 'ad', db: 'ad', param: textParam(200) },
    { name: 'paraBirimi', db: 'para_birimi', param: (v) => p.ascii(typeof v === 'string' ? v : null, 3) },
    ACTIVE,
  ],
  sira: false,
  spec: {
    key: 'kod',
    keyNoun: 'kod',
    fields: [
      { name: 'kod', label: 'Kod', kind: 'text', max: 50, required: true },
      { name: 'ad', label: 'Organizasyon adı', kind: 'text', max: 200, required: true },
      { name: 'paraBirimi', label: 'Para birimi', kind: 'currency' },
      { name: 'aktif', label: 'Aktif', kind: 'active' },
    ],
    headers: [
      ['Kod', 'kod'],
      ['Organizasyon Kodu', 'kod'],
      ['Şirket Kodu', 'kod'],
      ['Ad', 'ad'],
      ['Organizasyon Adı', 'ad'],
      ['Şirket Adı', 'ad'],
      ['Para Birimi', 'paraBirimi'],
      ...ACTIVE_HEADERS,
    ],
  },
  exportHeader: ['Organizasyon Kodu', 'Organizasyon Adı', 'Para Birimi', 'Aktif'],
  exportRow: (v) => [cell(v.kod), cell(v.ad), cell(v.paraBirimi), yesNo(v.aktif)],
  exportOrder: 'kod, id',
  duplicate: codeTaken,
  select: `SELECT x.id, x.kod, x.ad, x.para_birimi, x.aktif,
             (SELECT COUNT(*) FROM dbo.kullanicilar k WHERE k.organizasyon_id = x.id AND k.aktif = 1) AS kullanici_sayisi
           FROM dbo.organizasyonlar x`,
  search: '(x.kod LIKE @q OR x.ad LIKE @q)',
  pageOrder: 'x.kod, x.id',
  toRecord: (r: OrganizationRow) => ({ id: r.id, kod: r.kod, ad: r.ad, paraBirimi: r.para_birimi, aktif: r.aktif, kullaniciSayisi: r.kullanici_sayisi }),
  noun: 'organizasyon',
  describe: (r) => display(r.kod, r.ad),
  inUse: `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.kullanicilar WHERE organizasyon_id = @id)
                    OR EXISTS (SELECT 1 FROM dbo.masraf_formlari WHERE organizasyon_id = @id) THEN 1 ELSE 0 END AS used`,
  inUseMessage: 'Bu organizasyon kullanıcılara ya da masraf formlarına bağlı; silinemez. Silmek yerine pasifleştirin.',
  ruleField: null,
  notFoundMessage: 'Organizasyon bulunamadı.',
};

interface CostCenterRow {
  id: number;
  kod: string;
  aciklama: string | null;
  aktif: boolean;
  kullanici_sayisi: number;
}

export const COST_CENTERS: CrudDef<MasrafMerkezi> = {
  lock: 'masraf_merkezleri',
  title: 'Masraf Merkezleri',
  table: 'dbo.masraf_merkezleri',
  scope: null,
  columns: [{ name: 'kod', db: 'kod', param: textParam(50) }, { name: 'aciklama', db: 'aciklama', param: textParam(200) }, ACTIVE],
  sira: false,
  spec: {
    key: 'kod',
    keyNoun: 'kod',
    fields: [
      { name: 'kod', label: 'Kod', kind: 'text', max: 50, required: true },
      { name: 'aciklama', label: 'Açıklama', kind: 'text', max: 200 },
      { name: 'aktif', label: 'Aktif', kind: 'active' },
    ],
    headers: [
      ['Kod', 'kod'],
      ['Masraf Merkezi', 'kod'],
      ['Masraf Merkezi Kodu', 'kod'],
      ['Açıklama', 'aciklama'],
      ['Ad', 'aciklama'],
      ['Masraf Merkezi Açıklaması', 'aciklama'],
      ...ACTIVE_HEADERS,
    ],
  },
  exportHeader: ['Masraf Merkezi', 'Açıklama', 'Aktif'],
  exportRow: (v) => [cell(v.kod), cell(v.aciklama), yesNo(v.aktif)],
  exportOrder: 'kod, id',
  duplicate: codeTaken,
  select: `SELECT x.id, x.kod, x.aciklama, x.aktif,
             (SELECT COUNT(*) FROM dbo.kullanici_masraf_merkezleri km JOIN dbo.kullanicilar k ON k.id = km.kullanici_id
              WHERE km.masraf_merkezi_id = x.id AND k.aktif = 1) AS kullanici_sayisi
           FROM dbo.masraf_merkezleri x`,
  search: '(x.kod LIKE @q OR x.aciklama LIKE @q)',
  pageOrder: 'x.kod, x.id',
  toRecord: (r: CostCenterRow) => ({ id: r.id, kod: r.kod, aciklama: r.aciklama, gosterim: display(r.kod, r.aciklama), aktif: r.aktif, kullaniciSayisi: r.kullanici_sayisi }),
  noun: 'masraf_merkezi',
  describe: (r) => r.gosterim,
  inUse: `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.kullanici_masraf_merkezleri WHERE masraf_merkezi_id = @id)
                    OR EXISTS (SELECT 1 FROM dbo.masraf_formlari WHERE masraf_merkezi_id = @id) THEN 1 ELSE 0 END AS used`,
  inUseMessage: 'Bu masraf merkezi kullanıcılara tanımlı ya da masraf formlarında seçili; silinemez. Silmek yerine pasifleştirin.',
  ruleField: 'masrafMerkezi',
  notFoundMessage: 'Masraf merkezi bulunamadı.',
};

interface OptionRow {
  id: number;
  kod: string;
  ad: string | null;
  aktif: boolean;
  sira: number;
}

/** The options of one 'liste' field. */
export function optionsOf(field: ListeAlani): CrudDef<Secenek> {
  return {
    lock: `secenek_${field.id}`,
    title: field.ad,
    table: 'dbo.alan_secenekleri',
    scope: { column: 'alan_id', id: field.id },
    columns: [{ name: 'kod', db: 'kod', param: textParam(50) }, { name: 'ad', db: 'ad', param: textParam(200) }, ACTIVE],
    sira: true,
    spec: {
      key: 'kod',
      keyNoun: 'kod',
      fields: [
        { name: 'kod', label: 'Kod', kind: 'text', max: 50, required: true },
        { name: 'ad', label: 'Açıklama', kind: 'text', max: 200 },
        { name: 'aktif', label: 'Aktif', kind: 'active' },
      ],
      headers: optionHeaders(field.ad),
    },
    exportHeader: ['Kod', 'Açıklama', 'Aktif'],
    exportRow: (v) => [cell(v.kod), cell(v.ad), yesNo(v.aktif)],
    exportOrder: 'sira, kod, id',
    duplicate: codeTaken,
    select: 'SELECT x.id, x.kod, x.ad, x.aktif, x.sira FROM dbo.alan_secenekleri x',
    search: '(x.kod LIKE @q OR x.ad LIKE @q)',
    pageOrder: 'x.sira, x.kod, x.id',
    toRecord: (r: OptionRow) => ({ id: r.id, kod: r.kod, ad: r.ad, gosterim: display(r.kod, r.ad), aktif: r.aktif, sira: r.sira }),
    noun: 'secenek',
    describe: (r) => `${field.ad}: ${r.gosterim}`,
    inUse: `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.fis_alan_degerleri WHERE secenek_id = @id)
                      OR EXISTS (SELECT 1 FROM dbo.bekleyen_alan_degerleri WHERE secenek_id = @id) THEN 1 ELSE 0 END AS used`,
    inUseMessage: 'Bu seçenek fişlerde kullanılıyor; silinemez. Silmek yerine pasifleştirin.',
    ruleField: field.id,
    notFoundMessage: 'Seçenek bulunamadı.',
  };
}

/** Categories, for Excel; their edits are in src/expenses/categories.ts. */
export const CATEGORIES: ListDef = {
  lock: 'kategoriler',
  title: 'Kategoriler',
  table: 'dbo.masraf_kategorileri',
  scope: null,
  columns: [
    { name: 'ad', db: 'ad', param: textParam(60) },
    { name: 'kod', db: 'kod', param: textParam(50) },
    { name: 'kdvOranlari', db: 'kdv_oranlari', param: textParam(50) },
    { name: 'hesapKodu', db: 'hesap_kodu', param: textParam(50) },
    { name: 'simge', db: 'simge', param: (v) => p.ascii(typeof v === 'string' ? v : 'diger', 16) },
    ACTIVE,
  ],
  sira: true,
  spec: {
    key: 'ad',
    keyNoun: 'ad',
    fields: [
      { name: 'ad', label: 'Kategori adı', kind: 'text', max: 60, required: true },
      { name: 'kod', label: 'Kategori kodu', kind: 'text', max: 50 },
      { name: 'kdvOranlari', label: 'KDV oranları', kind: 'text', max: 50 },
      { name: 'hesapKodu', label: 'Hesap kodu', kind: 'text', max: 50 },
      { name: 'simge', label: 'Simge', kind: 'choice', choices: ICONS, fallback: 'diger' },
      { name: 'aktif', label: 'Aktif', kind: 'active' },
    ],
    headers: [
      ['Ad', 'ad'],
      ['Kategori', 'ad'],
      ['Kategori Adı', 'ad'],
      ['Kod', 'kod'],
      ['Kategori Kodu', 'kod'],
      ['KDV Oranları', 'kdvOranlari'],
      ['KDV Oranı', 'kdvOranlari'],
      ['Hesap Kodu', 'hesapKodu'],
      ['GL Kod', 'hesapKodu'],
      ['GL Kod 1', 'hesapKodu'],
      ['Simge', 'simge'],
      ...ACTIVE_HEADERS,
    ],
  },
  exportHeader: ['Kategori Adı', 'Kategori Kodu', 'KDV Oranları', 'Hesap Kodu', 'Simge', 'Aktif'],
  exportRow: (v) => [cell(v.ad), cell(v.kod), cell(v.kdvOranlari), cell(v.hesapKodu), cell(v.simge), yesNo(v.aktif)],
  exportOrder: 'sira, ad, id',
  duplicate: () => conflict('kategori_var', 'Dosyadaki bir kategori adı mevcut bir kategoriyle çakışıyor.'),
};

// ---------------------------------------------------------------------------------------------------
// Fields

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** A 'liste' field by key; others see it only while it is active. 404 otherwise. */
export async function findListField(ex: Executor, anahtar: string, includeInactive: boolean): Promise<ListeAlani> {
  const row = FIELD_KEY.test(anahtar)
    ? await queryOne<ListeAlani>(ex, `SELECT id, anahtar, ad, aktif FROM dbo.alan_tanimlari WHERE anahtar = @a AND tur = 'liste'`, { a: p.ascii(anahtar, 40) })
    : null;
  if (row === null || (!includeInactive && !row.aktif)) throw notFound('Alan bulunamadı.');
  return row;
}

// ---------------------------------------------------------------------------------------------------
// Paged list and edits

const likePattern = (q: string): string => `%${q.replace(/[%_[]/g, '[$&]')}%`;

function scopeOf(def: ListDef, alias = ''): { where: string[]; params: Record<string, Param> } {
  return def.scope === null
    ? { where: [], params: {} }
    : { where: [`${alias}${def.scope.column} = @scope`], params: { scope: p.int(def.scope.id) } };
}

export async function listRecords<T>(db: Db, def: CrudDef<T>, filter: ListFilter): Promise<Sayfa<T>> {
  const { where, params } = scopeOf(def, 'x.');
  if (filter.aktif !== undefined) {
    where.push('x.aktif = @aktif');
    params.aktif = p.bit(filter.aktif);
  }
  const q = filter.q?.trim();
  if (q !== undefined && q !== '') {
    where.push(def.search);
    params.q = p.str(likePattern(q), 300);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const [count, rows] = await Promise.all([
    queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${def.table} x ${clause}`, params),
    query<never>(db, `${def.select} ${clause} ORDER BY ${def.pageOrder} OFFSET @off ROWS FETCH NEXT @n ROWS ONLY`, {
      ...params,
      off: p.int((filter.sayfa - 1) * filter.adet),
      n: p.int(filter.adet),
    }),
  ]);
  return { kayitlar: rows.map((r) => def.toRecord(r)), toplam: count?.n ?? 0, sayfa: filter.sayfa, adet: filter.adet };
}

export async function getRecord<T>(ex: Executor, def: CrudDef<T>, id: number): Promise<T | null> {
  const { where, params } = scopeOf(def, 'x.');
  const row = await queryOne<never>(ex, `${def.select} WHERE ${['x.id = @id', ...where].join(' AND ')}`, { ...params, id: p.int(id) });
  return row === null ? null : def.toRecord(row);
}

/**
 * Starts a write of a list: takes the list's lock and, for options, keeps their field from being deleted
 * until the transaction ends (404 when it is already gone).
 */
async function beginWrite(tx: Executor, def: ListDef): Promise<void> {
  await lockList(tx, def.lock);
  if (def.scope === null) return;
  const field = await queryOne(tx, 'SELECT id FROM dbo.alan_tanimlari WITH (HOLDLOCK) WHERE id = @scope', scopeOf(def).params);
  if (field === null) throw notFound('Alan bulunamadı.');
}

async function nextSira(tx: Executor, def: ListDef): Promise<number> {
  const { where, params } = scopeOf(def);
  const row = await queryOne<{ n: number }>(tx, `SELECT ISNULL(MAX(sira), 0) AS n FROM ${def.table} ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  return (row?.n ?? 0) + 1;
}

/** Creates a record from the fields given (the others take their defaults). */
export async function createRecord<T>(db: Db, actor: Actor, def: CrudDef<T>, input: Readonly<Record<string, Value | undefined>>): Promise<T> {
  try {
    return await transaction(db, async (tx) => {
      await beginWrite(tx, def);
      const { params } = scopeOf(def);
      const names: string[] = def.scope === null ? [] : [def.scope.column];
      const values: string[] = def.scope === null ? [] : ['@scope'];
      def.columns.forEach((c, i) => {
        const v = input[c.name];
        if (v === undefined) return;
        names.push(c.db);
        values.push(`@c${i}`);
        params[`c${i}`] = c.param(v);
      });
      if (def.sira) {
        names.push('sira');
        values.push('@sira');
        params.sira = p.int(await nextSira(tx, def));
      }
      const row = await queryOne<{ id: number }>(tx, `INSERT INTO ${def.table} (${names.join(', ')}) OUTPUT inserted.id VALUES (${values.join(', ')})`, params);
      const created = row === null ? null : await getRecord(tx, def, row.id);
      if (created === null) throw new Error(`${def.noun} eklenemedi`);
      await audit(tx, actor.id, `${def.noun}_olusturuldu`, def.describe(created));
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw def.duplicate();
    throw err;
  }
}

const AUDIT_LABELS: Readonly<Record<string, string>> = { kod: 'kod', ad: 'ad', aciklama: 'açıklama', paraBirimi: 'para birimi', sira: 'sıra' };

function describeChanges(before: unknown, after: unknown): string {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, label] of Object.entries(AUDIT_LABELS)) {
    if (key in b && a[key] !== b[key]) out.push(`${label} ${String(a[key] ?? '-')} → ${String(b[key] ?? '-')}`);
  }
  if (a.aktif !== b.aktif) out.push(b.aktif === true ? 'aktif edildi' : 'pasifleştirildi');
  return out.join(', ');
}

/** Changes the fields given; `sira` too where the list has an order. */
export async function updateRecord<T>(db: Db, actor: Actor, def: CrudDef<T>, id: number, patch: Readonly<Record<string, Value | number | undefined>>): Promise<T> {
  try {
    return await transaction(db, async (tx) => {
      await beginWrite(tx, def);
      const before = await getRecord(tx, def, id);
      if (before === null) throw notFound(def.notFoundMessage);
      const sets: string[] = [];
      const params: Record<string, Param> = { id: p.int(id) };
      def.columns.forEach((c, i) => {
        const v = patch[c.name];
        if (v === undefined || typeof v === 'number') return;
        sets.push(`${c.db} = @c${i}`);
        params[`c${i}`] = c.param(v);
      });
      if (def.sira && typeof patch.sira === 'number') {
        sets.push('sira = @sira');
        params.sira = p.int(patch.sira);
      }
      if (sets.length > 0) await execute(tx, `UPDATE ${def.table} SET ${sets.join(', ')} WHERE id = @id`, params);
      const after = (await getRecord(tx, def, id)) as T;
      const changes = describeChanges(before, after);
      if (changes !== '') await audit(tx, actor.id, `${def.noun}_guncellendi`, `${def.describe(before)}: ${changes}`);
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw def.duplicate();
    throw err;
  }
}

/** Deletes an unused record and the rules that use it as their condition. 409 kullaniliyor when used. */
export async function deleteRecord<T>(db: Db, actor: Actor, def: CrudDef<T>, id: number): Promise<void> {
  const inUse = (): HttpError => conflict('kullaniliyor', def.inUseMessage);
  try {
    await transaction(db, async (tx) => {
      await beginWrite(tx, def);
      // A rule being written for this value holds the row (UPDLOCK) until it commits; waiting for it here
      // means its rule is deleted below, or it finds the value gone.
      await queryOne(tx, `SELECT id FROM ${def.table} WITH (UPDLOCK, ROWLOCK) WHERE id = @id`, { id: p.int(id) });
      const before = await getRecord(tx, def, id);
      if (before === null) throw notFound(def.notFoundMessage);
      const used = await queryOne<{ used: number }>(tx, def.inUse, { id: p.int(id) });
      if (used?.used === 1) throw inUse();
      const rules = def.ruleField === null ? 0 : await deleteRulesOf(tx, def.ruleField, [id]);
      await execute(tx, `DELETE FROM ${def.table} WHERE id = @id`, { id: p.int(id) });
      await audit(tx, actor.id, `${def.noun}_silindi`, `${def.describe(before)}${rules > 0 ? ` (${rules} zorunluluk kuralı da silindi)` : ''}`);
    });
  } catch (err) {
    // Chosen by someone after the check above: the foreign key refuses the delete.
    if (sqlErrorNumber(err) === SQL_ERROR.foreignKey) throw inUse();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------
// Excel

async function loadStored(ex: Executor, def: ListDef, order?: string): Promise<StoredRow[]> {
  const { where, params } = scopeOf(def);
  const rows = await query<Record<string, Value> & { id: number }>(
    ex,
    `SELECT id, ${def.columns.map((c) => `${c.db} AS [${c.name}]`).join(', ')} FROM ${def.table}
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ${order === undefined ? '' : `ORDER BY ${order}`}`,
    params,
  );
  return rows.map(({ id, ...values }) => ({ id, values }));
}

/** YYYY-MM-DD of the server's local date. */
function localDate(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every row of the list, inactive ones too, as an .xlsx file named "<list>_<YYYY-MM-DD>.xlsx". */
export async function exportList(db: Db, def: ListDef): Promise<{ readonly file: Buffer; readonly fileName: string }> {
  const rows = await loadStored(db, def, def.exportOrder);
  const file = writeXlsx({ name: def.title, header: def.exportHeader, rows: rows.map((r) => def.exportRow(r.values)) });
  return { file, fileName: `${def.title}_${localDate()}.xlsx` };
}

async function insertRows(tx: Executor, def: ListDef, rows: ReadonlyArray<Readonly<Record<string, Value>>>): Promise<void> {
  if (rows.length === 0) return;
  const first = def.sira ? await nextSira(tx, def) : 0;
  const names = [...(def.scope === null ? [] : [def.scope.column]), ...def.columns.map((c) => c.db), ...(def.sira ? ['sira'] : [])];
  const perRow = def.columns.length + (def.sira ? 1 : 0);
  const size = Math.min(MAX_VALUES_ROWS, Math.floor(MAX_PARAMS / perRow));
  for (let start = 0; start < rows.length; start += size) {
    const { params } = scopeOf(def);
    const tuples = rows.slice(start, start + size).map((row, i) => {
      const refs = def.columns.map((c, j) => {
        params[`v${i}_${j}`] = c.param(row[c.name] ?? null);
        return `@v${i}_${j}`;
      });
      if (def.sira) {
        params[`s${i}`] = p.int(first + start + i);
        refs.push(`@s${i}`);
      }
      return `(${[...(def.scope === null ? [] : ['@scope']), ...refs].join(', ')})`;
    });
    await execute(tx, `INSERT INTO ${def.table} (${names.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
}

async function updateRows(tx: Executor, def: ListDef, rows: ReadonlyArray<{ readonly id: number; readonly values: Readonly<Record<string, Value>> }>): Promise<void> {
  const size = Math.min(MAX_VALUES_ROWS, Math.floor(MAX_PARAMS / (def.columns.length + 1)));
  const sets = def.columns.map((c, j) => `t.${c.db} = v.c${j}`).join(', ');
  const names = ['id', ...def.columns.map((_, j) => `c${j}`)].join(', ');
  for (let start = 0; start < rows.length; start += size) {
    const params: Record<string, Param> = {};
    const tuples = rows.slice(start, start + size).map((row, i) => {
      params[`i${i}`] = p.int(row.id);
      const refs = def.columns.map((c, j) => {
        params[`v${i}_${j}`] = c.param(row.values[c.name] ?? null);
        return `@v${i}_${j}`;
      });
      return `(@i${i}, ${refs.join(', ')})`;
    });
    await execute(tx, `UPDATE t SET ${sets} FROM ${def.table} t JOIN (VALUES ${tuples.join(', ')}) v (${names}) ON t.id = v.id`, params);
  }
}

async function deactivateRows(tx: Executor, def: ListDef, ids: readonly number[]): Promise<void> {
  for (let start = 0; start < ids.length; start += MAX_PARAMS) {
    const chunk = ids.slice(start, start + MAX_PARAMS);
    await execute(
      tx,
      `UPDATE ${def.table} SET aktif = 0 WHERE id IN (${chunk.map((_, i) => `@d${i}`).join(', ')})`,
      Object.fromEntries(chunk.map((id, i) => [`d${i}`, p.int(id)])),
    );
  }
}

/**
 * Imports an .xlsx file into a list. With `preview` nothing is written. Otherwise the whole import runs in
 * one transaction under the list's lock and leaves one audit line.
 */
export async function importList(db: Db, actor: Actor, def: ListDef, file: Buffer, options: ImportOptions): Promise<IceAktarim> {
  const rows = readXlsx(file, { maxDataRows: MAX_IMPORT_ROWS, maxBytes: MAX_IMPORT_INFLATED });
  const plan = async (ex: Executor) => planImport(def.spec, rows, await loadStored(ex, def), { deactivateMissing: options.deactivateMissing });
  if (options.preview) return importResult(await plan(db), true);
  try {
    return await transaction(db, async (tx) => {
      await beginWrite(tx, def);
      const planned = await plan(tx);
      await insertRows(tx, def, planned.inserts);
      await updateRows(tx, def, planned.updates);
      await deactivateRows(tx, def, planned.deactivate);
      const r = importResult(planned, false);
      await audit(
        tx,
        actor.id,
        'tanim_ice_aktarildi',
        `${def.title}: ${r.satirSayisi} satır; ${r.eklenen} eklendi, ${r.guncellenen} güncellendi, ${r.degismeyen} değişmedi, ${r.pasiflestirilen} pasifleştirildi, ${r.hataSayisi} hatalı satır atlandı.`,
      );
      return r;
    });
  } catch (err) {
    // Two codes the application compares as different but the collation as equal.
    if (isUniqueViolation(err)) throw def.duplicate();
    throw err;
  }
}
