import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InvoiceSchema, type Invoice } from './invoice-schema.ts';
import { ClaudeOlcumSchema, type ClaudeOlcum } from './olcum.ts';

const ID_REGEX = /^(\d{4})(\d{2})(\d{2})-\d{6}-[a-f0-9]{8}$/;
const HASH_REGEX = /^[a-f0-9]{64}$/;

const StoredRecordSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
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

export interface NewRecord {
  readonly dosyaAdi: string;
  readonly sonuc: Invoice;
  readonly dosyaOzeti?: string;
  readonly olcum?: ClaudeOlcum;
}

export interface InvoiceStorage {
  save(input: NewRecord, now?: Date): Promise<StoredRecord>;
  get(id: string): Promise<StoredRecord | null>;
  list(limit?: number): Promise<RecordSummary[]>;
  /** Newest record made from a file with this SHA-256, or null. */
  findByHash(dosyaOzeti: string): Promise<StoredRecord | null>;
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

/** One JSON file per invoice: <dataDir>/<YYYY-MM-DD>/<id>.json. IDs are validated, so paths stay inside dataDir. */
export function createInvoiceStorage(dataDir: string): InvoiceStorage {
  const dayDir = (id: string): string | null => {
    const m = ID_REGEX.exec(id);
    return m === null ? null : join(dataDir, `${m[1]}-${m[2]}-${m[3]}`);
  };

  const get = async (id: string): Promise<StoredRecord | null> => {
    const dir = dayDir(id);
    if (dir === null) return null;
    let text: string;
    try {
      text = await readFile(join(dir, `${id}.json`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null; // A hand-edited or truncated file must not break the history list.
    }
    const parsed = StoredRecordSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  };

  /** Record ids, newest first. */
  async function* ids(): AsyncGenerator<string> {
    let days: string[];
    try {
      days = (await readdir(dataDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
        .map((d) => d.name)
        .sort()
        .reverse();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const day of days) {
      yield* (await readdir(join(dataDir, day)))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((id) => ID_REGEX.test(id))
        .sort()
        .reverse();
    }
  }

  // File hash -> record id. Built from disk on first use, then kept current by save().
  const byHash = new Map<string, string>();
  let indexReady: Promise<void> | null = null;
  const ensureIndex = (): Promise<void> => {
    indexReady ??= (async () => {
      for await (const id of ids()) {
        const rec = await get(id);
        // Newest first: keep the first id seen; save() may already have added a newer one.
        if (rec?.dosyaOzeti !== undefined && !byHash.has(rec.dosyaOzeti)) byHash.set(rec.dosyaOzeti, id);
      }
    })().catch((err: unknown) => {
      indexReady = null;
      throw err;
    });
    return indexReady;
  };

  return {
    async save({ dosyaAdi, sonuc, dosyaOzeti, olcum }, now = new Date()) {
      const id = newRecordId(now);
      const dir = dayDir(id);
      if (dir === null) throw new Error('kayıt kimliği üretilemedi');
      const record: StoredRecord = {
        id,
        dosyaAdi: cleanFileName(dosyaAdi),
        olusturulma: now.toISOString(),
        ...(dosyaOzeti !== undefined && HASH_REGEX.test(dosyaOzeti) ? { dosyaOzeti } : {}),
        ...(olcum !== undefined ? { olcum } : {}),
        sonuc,
      };
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      if (record.dosyaOzeti !== undefined) byHash.set(record.dosyaOzeti, id);
      return record;
    },

    get,

    async list(limit = 100) {
      const out: RecordSummary[] = [];
      for await (const id of ids()) {
        if (out.length >= limit) break;
        const rec = await get(id);
        if (rec === null) continue;
        out.push({
          id: rec.id,
          dosyaAdi: rec.dosyaAdi,
          olusturulma: rec.olusturulma,
          faturaNo: rec.sonuc.fatura.faturaNo,
          saticiUnvan: rec.sonuc.fatura.saticiUnvan,
          genelToplam: rec.sonuc.fatura.genelToplam,
          paraBirimi: rec.sonuc.fatura.paraBirimi,
        });
      }
      return out;
    },

    async findByHash(dosyaOzeti) {
      if (!HASH_REGEX.test(dosyaOzeti)) return null;
      await ensureIndex();
      const id = byHash.get(dosyaOzeti);
      if (id === undefined) return null;
      const rec = await get(id);
      if (rec === null) byHash.delete(dosyaOzeti); // the file was deleted or edited by hand
      return rec;
    },
  };
}
