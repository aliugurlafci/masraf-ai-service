// An in-memory InvoiceStorage for tests of the reader, queue and activity log, which only need
// somewhere to save and find readings. The SQL storage itself is tested in tests/invoice/storage.test.ts.
import { cleanFileName, newRecordId, type InvoiceFile, type InvoiceStorage, type StoredRecord } from '../src/invoice/storage.ts';

export function createMemoryStorage(): InvoiceStorage {
  const records: StoredRecord[] = [];
  const files = new Map<string, InvoiceFile>();
  const uploads: Array<{ kayitId: string; kullaniciId: number }> = [];

  return {
    async save({ dosyaAdi, sonuc, dosyaOzeti, olcum, dosya }, now = new Date()) {
      const record: StoredRecord = {
        id: newRecordId(now),
        dosyaAdi: cleanFileName(dosyaAdi),
        olusturulma: now.toISOString(),
        ...(dosyaOzeti !== undefined ? { dosyaOzeti } : {}),
        ...(olcum !== undefined ? { olcum } : {}),
        sonuc,
      };
      records.unshift(record);
      if (dosya !== undefined) files.set(record.id, dosya);
      return record;
    },
    async get(id) {
      return records.find((r) => r.id === id) ?? null;
    },
    async list({ limit = 100 } = {}) {
      return records.slice(0, limit).map((r) => ({
        id: r.id,
        dosyaAdi: r.dosyaAdi,
        olusturulma: r.olusturulma,
        faturaNo: r.sonuc.fatura.faturaNo,
        saticiUnvan: r.sonuc.fatura.saticiUnvan,
        genelToplam: r.sonuc.fatura.genelToplam,
        paraBirimi: r.sonuc.fatura.paraBirimi,
      }));
    },
    async findByHash(hash) {
      return records.find((r) => r.dosyaOzeti === hash) ?? null;
    },
    async addUpload({ kayitId, kullaniciId, dosya }) {
      uploads.push({ kayitId, kullaniciId });
      if (dosya !== undefined && !files.has(kayitId)) files.set(kayitId, dosya);
    },
    async getFile(id) {
      return files.get(id) ?? null;
    },
    async canRead(id, actor) {
      return actor.rol !== 'calisan' || uploads.some((u) => u.kayitId === id && u.kullaniciId === actor.id);
    },
  };
}
