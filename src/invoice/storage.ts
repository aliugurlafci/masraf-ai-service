import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { InvoiceSchema, type Invoice } from './schema.ts';
import { ClaudeOlcumSchema, type ClaudeOlcum } from '../claude/olcum.ts';
import { execute, iso, p, query, queryOne, transaction, type Db, type Param } from '../db/sql.ts';
import { isPrivileged, type Actor } from '../expenses/rules.ts';

export const RECORD_ID_REGEX = /^(\d{4})(\d{2})(\d{2})-\d{6}-[a-f0-9]{8}$/;
const HASH_REGEX = /^[a-f0-9]{64}$/;

/** A stored reading, as the API returns it. Same shape as the JSON files the service used to write. */
export const StoredRecordSchema = z
  .object({
    id: z.string().regex(RECORD_ID_REGEX),
    dosyaAdi: z.string(),
    olusturulma: z.string(),
    /** SHA-256 of the uploaded file; lets a repeated upload reuse the stored result. */
    dosyaOzeti: z.string().regex(HASH_REGEX).optional(),
    /** Measurements of the Claude run; a malformed value is dropped rather than hiding the record. */
    olcum: ClaudeOlcumSchema.optional().catch(undefined),
    sonuc: InvoiceSchema,
  })
  .strict();

export type StoredRecord = z.infer<typeof StoredRecordSchema>;

export interface RecordSummary {
  readonly id: string;
  readonly dosyaAdi: string;
  readonly olusturulma: string;
  readonly faturaNo: string | null;
  readonly saticiUnvan: string | null;
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
}

export interface InvoiceFile {
  readonly icerik: Buffer;
  readonly mime: string;
}

export interface NewRecord {
  readonly dosyaAdi: string;
  readonly sonuc: Invoice;
  readonly dosyaOzeti?: string;
  readonly olcum?: ClaudeOlcum;
  /** The original file, kept so approvers can see it. */
  readonly dosya?: InvoiceFile;
  readonly yukleyenId?: number | null;
}

export interface Upload {
  readonly kayitId: string;
  readonly kullaniciId: number;
  readonly dosyaAdi: string;
  /** Stored when the record has no file yet (records imported from the old JSON files). */
  readonly dosya?: InvoiceFile;
}

export interface ListOptions {
  readonly limit?: number;
  /** Only records this user uploaded, newest upload first. */
  readonly kullaniciId?: number;
}

export interface InvoiceStorage {
  save(input: NewRecord, now?: Date): Promise<StoredRecord>;
  get(id: string): Promise<StoredRecord | null>;
  list(opts?: ListOptions): Promise<RecordSummary[]>;
  /** Newest record made from a file with this SHA-256, or null. */
  findByHash(dosyaOzeti: string): Promise<StoredRecord | null>;
  /** Notes that a user sent this file; that is what gives them access to the record. */
  addUpload(upload: Upload): Promise<void>;
  getFile(id: string): Promise<InvoiceFile | null>;
  /** Uploader, owner or approver of a form that uses it, or accounting/administrator. */
  canRead(id: string, actor: Actor): Promise<boolean>;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function newRecordId(now: Date): string {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${date}-${time}-${randomBytes(4).toString('hex')}`;
}

/** Strips path parts and control characters from a client-supplied file name. */
export function cleanFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned === '' ? 'fatura' : cleaned;
}

interface RecordRow {
  id: string;
  dosya_adi: string;
  dosya_ozeti: string | null;
  olusturma: Date;
  sonuc: string;
  olcum: string | null;
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A row whose JSON no longer fits the schema (edited by hand) is treated as missing, not as an error. */
function toRecord(r: RecordRow): StoredRecord | null {
  const parsed = StoredRecordSchema.safeParse({
    id: r.id,
    dosyaAdi: r.dosya_adi,
    olusturulma: iso(r.olusturma),
    ...(r.dosya_ozeti !== null ? { dosyaOzeti: r.dosya_ozeti } : {}),
    ...(r.olcum !== null ? { olcum: parseJson(r.olcum) } : {}),
    sonuc: parseJson(r.sonuc),
  });
  if (!parsed.success) return null;
  const { olcum, ...rest } = parsed.data;
  return olcum === undefined ? rest : { ...rest, olcum };
}

const RECORD_COLUMNS = 'id, dosya_adi, dosya_ozeti, olusturma, sonuc, olcum';

/** A real calendar date in a plausible range, or null (a misread date must not fail the insert). */
function listableDate(s: string | null): string | null {
  if (s === null) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  const year = d.getUTCFullYear();
  return year >= 1900 && year <= 2999 ? s : null;
}

/** Copies a few invoice fields into columns for lists; out-of-range values are left out, never fatal. */
function summaryColumns(sonuc: Invoice): Record<string, Param> {
  const f = sonuc.fatura;
  const total = f.genelToplam !== null && Number.isFinite(f.genelToplam) ? f.genelToplam : null;
  return {
    no: p.str(f.faturaNo?.slice(0, 200) ?? null, 200),
    tarih: p.date(listableDate(f.faturaTarihi)),
    satici: p.str(f.saticiUnvan?.slice(0, 400) ?? null, 400),
    toplam: p.float(total),
    pb: p.ascii(f.paraBirimi, 3),
  };
}

async function insertFile(ex: Parameters<typeof execute>[0], kayitId: string, file: InvoiceFile): Promise<void> {
  await execute(
    ex,
    `IF NOT EXISTS (SELECT 1 FROM dbo.fatura_dosyalari WITH (UPDLOCK, HOLDLOCK) WHERE kayit_id = @id)
       INSERT INTO dbo.fatura_dosyalari (kayit_id, mime, boyut, icerik) VALUES (@id, @mime, @boyut, @icerik)`,
    { id: p.ascii(kayitId, 24), mime: p.ascii(file.mime, 40), boyut: p.int(file.icerik.length), icerik: p.bytes(file.icerik) },
  );
}

export function createInvoiceStorage(db: Db): InvoiceStorage {
  const get = async (id: string): Promise<StoredRecord | null> => {
    if (!RECORD_ID_REGEX.test(id)) return null;
    const row = await queryOne<RecordRow>(db, `SELECT ${RECORD_COLUMNS} FROM dbo.fatura_kayitlari WHERE id = @id`, { id: p.ascii(id, 24) });
    return row === null ? null : toRecord(row);
  };

  return {
    async save({ dosyaAdi, sonuc, dosyaOzeti, olcum, dosya, yukleyenId }, now = new Date()) {
      const record: StoredRecord = {
        id: newRecordId(now),
        dosyaAdi: cleanFileName(dosyaAdi),
        olusturulma: now.toISOString(),
        ...(dosyaOzeti !== undefined && HASH_REGEX.test(dosyaOzeti) ? { dosyaOzeti } : {}),
        ...(olcum !== undefined ? { olcum } : {}),
        sonuc,
      };
      await transaction(db, async (tx) => {
        await execute(
          tx,
          `INSERT INTO dbo.fatura_kayitlari
             (id, dosya_adi, dosya_ozeti, olusturma, yukleyen_id, sonuc, olcum, fatura_no, fatura_tarihi, satici_unvan, genel_toplam, para_birimi)
           VALUES (@id, @ad, @ozet, @olusturma, @yukleyen, @sonuc, @olcum, @no, @tarih, @satici, @toplam, @pb)`,
          {
            id: p.ascii(record.id, 24),
            ad: p.str(record.dosyaAdi, 200),
            ozet: p.ascii(record.dosyaOzeti ?? null, 64),
            olusturma: p.time(now),
            yukleyen: p.int(yukleyenId ?? null),
            sonuc: p.text(JSON.stringify(sonuc)),
            olcum: p.text(olcum === undefined ? null : JSON.stringify(olcum)),
            ...summaryColumns(sonuc),
          },
        );
        if (dosya !== undefined) await insertFile(tx, record.id, dosya);
      });
      return record;
    },

    get,

    async list({ limit = 100, kullaniciId }: ListOptions = {}) {
      const rows = await query<RecordRow & { fatura_no: string | null; satici_unvan: string | null; genel_toplam: number | null; para_birimi: string | null }>(
        db,
        kullaniciId === undefined
          ? `SELECT TOP (@n) id, dosya_adi, olusturma, fatura_no, satici_unvan, genel_toplam, para_birimi
             FROM dbo.fatura_kayitlari ORDER BY olusturma DESC, id DESC`
          : `SELECT TOP (@n) r.id, r.dosya_adi, r.olusturma, r.fatura_no, r.satici_unvan, r.genel_toplam, r.para_birimi
             FROM dbo.fatura_kayitlari r
             JOIN (SELECT kayit_id, MAX(tarih) AS son FROM dbo.fatura_yuklemeleri WHERE kullanici_id = @k GROUP BY kayit_id) y
               ON y.kayit_id = r.id
             ORDER BY y.son DESC, r.id DESC`,
        { n: p.int(limit), k: p.int(kullaniciId ?? null) },
      );
      return rows.map((r) => ({
        id: r.id,
        dosyaAdi: r.dosya_adi,
        olusturulma: iso(r.olusturma) ?? '',
        faturaNo: r.fatura_no,
        saticiUnvan: r.satici_unvan,
        genelToplam: r.genel_toplam,
        paraBirimi: r.para_birimi,
      }));
    },

    async findByHash(dosyaOzeti) {
      if (!HASH_REGEX.test(dosyaOzeti)) return null;
      // Newest first; a row that no longer parses is skipped so an older good one can answer.
      const rows = await query<RecordRow>(
        db,
        `SELECT TOP (5) ${RECORD_COLUMNS} FROM dbo.fatura_kayitlari WHERE dosya_ozeti = @h ORDER BY olusturma DESC, id DESC`,
        { h: p.ascii(dosyaOzeti, 64) },
      );
      for (const row of rows) {
        const rec = toRecord(row);
        if (rec !== null) return rec;
      }
      return null;
    },

    async addUpload({ kayitId, kullaniciId, dosyaAdi, dosya }) {
      await transaction(db, async (tx) => {
        await execute(tx, 'INSERT INTO dbo.fatura_yuklemeleri (kayit_id, kullanici_id, dosya_adi) VALUES (@id, @k, @ad)', {
          id: p.ascii(kayitId, 24),
          k: p.int(kullaniciId),
          ad: p.str(cleanFileName(dosyaAdi), 200),
        });
        if (dosya !== undefined) await insertFile(tx, kayitId, dosya);
      });
    },

    async getFile(id) {
      if (!RECORD_ID_REGEX.test(id)) return null;
      const row = await queryOne<{ mime: string; icerik: Buffer }>(db, 'SELECT mime, icerik FROM dbo.fatura_dosyalari WHERE kayit_id = @id', {
        id: p.ascii(id, 24),
      });
      return row === null ? null : { mime: row.mime, icerik: row.icerik };
    },

    async canRead(id, actor) {
      if (!RECORD_ID_REGEX.test(id)) return false;
      const row = await queryOne<{ ok: number }>(
        db,
        isPrivileged(actor)
          ? 'SELECT 1 AS ok FROM dbo.fatura_kayitlari WHERE id = @id'
          : `SELECT 1 AS ok WHERE
               EXISTS (SELECT 1 FROM dbo.fatura_yuklemeleri WHERE kayit_id = @id AND kullanici_id = @k)
               OR EXISTS (SELECT 1 FROM dbo.form_faturalari ff JOIN dbo.masraf_formlari f ON f.id = ff.form_id
                          WHERE ff.kayit_id = @id AND f.olusturan_id = @k)
               OR EXISTS (SELECT 1 FROM dbo.form_faturalari ff JOIN dbo.form_onaylari o ON o.form_id = ff.form_id
                          WHERE ff.kayit_id = @id AND o.onayci_id = @k)`,
        { id: p.ascii(id, 24), k: p.int(actor.id) },
      );
      return row !== null;
    },
  };
}
