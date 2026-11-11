// The values an integration can send for one form (docs/onay-sistemi.md, section 9, "Kaynak alanlar").
// The form and its invoices come from the expense service's detail, so every invoice value is its
// effective data (the correction when there is one) exactly as the panel and the PDF show it.
import { p, query, queryOne, type Db } from '../db/sql.ts';
import { loadDefinitions } from '../definitions/fields.ts';
import { HttpError } from '../errors.ts';
import { isEntryField } from '../expenses/field-rules.ts';
import type { ExpenseService, MasrafDetay } from '../expenses/forms.ts';
import { invoicesLocalTotal, type Actor } from '../expenses/rules.ts';
import { HEADER_FIELDS, localDate, RECEIPT_FIELD_PREFIX, type PayloadData, type Value } from './payload.ts';

export interface LoadedForm {
  readonly data: PayloadData;
  readonly form: { readonly id: number; readonly baslik: string };
}

/** The values of a form; null when there is no such form. */
export type LoadPayload = (formId: number) => Promise<LoadedForm | null>;

// The system reads the form as an administrator would; no permission is taken from it.
const SYSTEM: Actor = { id: 0, rol: 'yonetici' };

const dateOf = (at: string | null): string | null => (at === null ? null : localDate(new Date(at)));

export function createPayloadLoader(db: Db, expenses: Pick<ExpenseService, 'detail'>, baseCurrency: string): LoadPayload {
  return async (formId) => {
    let d: MasrafDetay;
    try {
      d = await expenses.detail(formId, SYSTEM);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
    const extra = await queryOne<{ kategori_kod: string | null; hesap_kodu: string | null; eposta: string; departman: string | null }>(
      db,
      `SELECT k.kod AS kategori_kod, k.hesap_kodu, u.eposta, u.departman
       FROM dbo.masraf_formlari f JOIN dbo.masraf_kategorileri k ON k.id = f.kategori_id JOIN dbo.kullanicilar u ON u.id = f.olusturan_id
       WHERE f.id = @f`,
      { f: p.int(formId) },
    );
    const entries = (await loadDefinitions(db)).fields.filter(isEntryField);
    const listKeys = new Set(entries.filter((f) => f.tur === 'liste').map((f) => f.anahtar));
    const optionIds = new Set<number>();
    for (const invoice of d.faturalar) {
      for (const [key, value] of Object.entries(invoice.alanlar)) if (listKeys.has(key) && typeof value.deger === 'number') optionIds.add(value.deger);
    }
    const options = new Map<number, { kod: string; ad: string | null }>();
    if (optionIds.size > 0) {
      const rows = await query<{ id: number; kod: string; ad: string | null }>(
        db,
        'SELECT id, kod, ad FROM dbo.alan_secenekleri WHERE id IN (SELECT CAST([value] AS INT) FROM OPENJSON(@ids))',
        { ids: p.text(JSON.stringify([...optionIds])) },
      );
      for (const r of rows) options.set(r.id, { kod: r.kod, ad: r.ad });
    }

    const decided = d.durum === 'onaylandi' || d.durum === 'odendi';
    const lastApprover = d.onaylar.filter((s) => s.durum === 'onaylandi').reduce<(typeof d.onaylar)[number] | null>((a, s) => (a === null || s.sira > a.sira ? s : a), null);
    const form: Record<string, Value> = {
      'form.no': d.id,
      'form.baslik': d.baslik,
      'form.aciklama': d.aciklama,
      'form.masrafTarihi': d.masrafTarihi,
      'form.tutar': d.tutar,
      'form.paraBirimi': d.paraBirimi,
      'form.kur': d.kur,
      'form.yerelTutar': d.yerelTutar,
      'form.onayTutari': d.onayTutari,
      'form.satici': d.satici,
      'form.durum': d.durum,
      'form.kategori': d.kategori.ad,
      'form.kategoriKodu': extra?.kategori_kod ?? null,
      'form.hesapKodu': extra?.hesap_kodu ?? null,
      'form.masrafMerkezi': d.masrafMerkezi?.kod ?? null,
      'form.masrafMerkeziAciklama': d.masrafMerkezi?.aciklama ?? null,
      'form.organizasyon': d.organizasyon?.kod ?? null,
      'form.organizasyonAdi': d.organizasyon?.ad ?? null,
      'form.gonderen': d.olusturan.adSoyad,
      'form.gonderenEposta': extra?.eposta ?? null,
      'form.departman': extra?.departman ?? null,
      'form.gonderimTarihi': dateOf(d.gonderim),
      'form.onayTarihi': decided ? dateOf(d.sonuclanma) : null,
      'form.odemeTarihi': dateOf(d.odeme),
      'form.sonOnaylayan': lastApprover?.onayci.adSoyad ?? null,
      'form.fisSayisi': d.faturalar.length,
    };

    const money = { tutar: 0, paraBirimi: d.paraBirimi, kur: d.kur };
    const fisler = d.faturalar.map((invoice, i) => {
      const values: Record<string, Value> = {
        'fis.sira': i + 1,
        'fis.kimlik': invoice.id,
        'fis.dosyaAdi': invoice.dosyaAdi,
        'fis.yerelKarsilik': invoice.yerelKarsilik,
        'fis.yerelTutar': invoicesLocalTotal(money, baseCurrency, [invoice]),
      };
      for (const [key] of HEADER_FIELDS) values[`fis.${key}`] = invoice[key];
      for (const field of entries) {
        const value = invoice.alanlar[field.anahtar];
        const key = `${RECEIPT_FIELD_PREFIX}${field.anahtar}`;
        if (field.tur === 'liste') {
          const option = typeof value?.deger === 'number' ? options.get(value.deger) : undefined;
          values[key] = option?.kod ?? null;
          values[`${key}.ad`] = option?.ad ?? null;
        } else if (value === undefined) values[key] = null;
        else values[key] = field.tur === 'sayi' && typeof value.deger === 'number' ? value.deger : String(value.deger);
      }
      return values;
    });
    return { data: { form, fisler }, form: { id: d.id, baslik: d.baslik } };
  };
}
