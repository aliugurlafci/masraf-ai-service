// Required receipt fields and their rules (docs/onay-sistemi.md, section 3, "Fiş alanları, masraf merkezi
// ve zorunluluk kuralları"). No database.
import { describe, expect, it } from 'vitest';
import {
  editableProps,
  formRequiredFields,
  keyOfName,
  missingReceiptFields,
  newFieldKey,
  parseReceiptValue,
  receiptRequiredFields,
  requiredFields,
  ruleApplies,
  sameValue,
  valueView,
  type FieldDef,
  type FieldRule,
} from '../../src/expenses/field-rules.ts';
import { sampleInvoice } from '../helpers.ts';

let nextId = 0;
const field = (anahtar: string, over: Partial<FieldDef> = {}): FieldDef => ({
  id: ++nextId,
  anahtar,
  ad: anahtar,
  duzey: 'fis',
  tur: 'liste',
  zorunlu: false,
  aktif: true,
  sira: nextId,
  ...over,
});

// As the schema file (001_baslangic.sql) seeds them (a few of them).
const kategori = field('kategori', { duzey: 'form', tur: 'kategori', zorunlu: true, sira: 1 });
const masrafMerkezi = field('masrafMerkezi', { duzey: 'form', tur: 'masraf_merkezi', sira: 2 });
const faturaNo = field('faturaNo', { tur: 'fatura', zorunlu: true, sira: 1 });
const saticiUnvan = field('saticiUnvan', { tur: 'fatura', zorunlu: true, sira: 3 });
const saticiVergiNo = field('saticiVergiNo', { tur: 'fatura', sira: 4 });
const etiket = field('etiket', { sira: 11 });
const projeKodu = field('projeKodu', { sira: 12 });
const dokumanTipi = field('dokumanTipi', { sira: 14 });
const not = field('not', { tur: 'uzun_metin', sira: 17 });
const FIELDS: FieldDef[] = [kategori, masrafMerkezi, faturaNo, saticiUnvan, saticiVergiNo, etiket, projeKodu, dokumanTipi, not];

const ARAC_BAKIM = 12; // a category id
const MM_1 = 4; // a cost centre id
const FATURA = 33; // the "Fatura" option of dokumanTipi
const rule = (kosulAlan: string, kosulDegerId: number, hedefler: string[], id = ++nextId): FieldRule => ({ id, kosulAlan, kosulDegerId, hedefler });

const keys = (fields: readonly FieldDef[]): string[] => fields.map((f) => f.anahtar);
const with_ = (changes: Record<string, Partial<FieldDef>>): FieldDef[] => FIELDS.map((f) => ({ ...f, ...changes[f.anahtar] }));
const form = { kategoriId: 1, masrafMerkeziId: null };

describe('ruleApplies', () => {
  const byKey = new Map(FIELDS.map((f) => [f.anahtar, f]));

  it('matches a category or cost centre condition on the form', () => {
    expect(ruleApplies(rule('kategori', ARAC_BAKIM, ['etiket']), byKey, { kategoriId: ARAC_BAKIM, masrafMerkeziId: null })).toBe(true);
    expect(ruleApplies(rule('kategori', ARAC_BAKIM, ['etiket']), byKey, form)).toBe(false);
    expect(ruleApplies(rule('masrafMerkezi', MM_1, ['etiket']), byKey, { kategoriId: 1, masrafMerkeziId: MM_1 })).toBe(true);
    expect(ruleApplies(rule('masrafMerkezi', MM_1, ['etiket']), byKey, form)).toBe(false);
  });

  it('matches a receipt list condition on the receipt value', () => {
    const r = rule('dokumanTipi', FATURA, ['saticiVergiNo']);
    expect(ruleApplies(r, byKey, form, { dokumanTipi: FATURA })).toBe(true);
    expect(ruleApplies(r, byKey, form, { dokumanTipi: FATURA + 1 })).toBe(false);
    expect(ruleApplies(r, byKey, form, {})).toBe(false);
  });

  it('never applies when the condition field is inactive or unknown, or not a list', () => {
    const inactive = new Map(with_({ dokumanTipi: { aktif: false } }).map((f) => [f.anahtar, f]));
    expect(ruleApplies(rule('dokumanTipi', FATURA, ['saticiVergiNo']), inactive, form, { dokumanTipi: FATURA })).toBe(false);
    const noCostCentre = new Map(with_({ masrafMerkezi: { aktif: false } }).map((f) => [f.anahtar, f]));
    expect(ruleApplies(rule('masrafMerkezi', MM_1, ['etiket']), noCostCentre, { kategoriId: 1, masrafMerkeziId: MM_1 })).toBe(false);
    expect(ruleApplies(rule('yok', 1, ['etiket']), byKey, form, { yok: 1 })).toBe(false);
    expect(ruleApplies(rule('not', 1, ['etiket']), byKey, form, { not: 1 })).toBe(false);
  });
});

describe('requiredFields', () => {
  it('starts with the marked header fields, header fields first', () => {
    expect(keys(receiptRequiredFields(FIELDS, [], form))).toEqual(['faturaNo', 'saticiUnvan']);
    expect(formRequiredFields(FIELDS, [], form)).toEqual([]);
    expect(requiredFields(FIELDS, [], form)).toEqual({ form: [], fis: ['faturaNo', 'saticiUnvan'] });
  });

  it('orders header fields by sira first, then the other receipt fields by sira and id', () => {
    const fields = with_({ not: { zorunlu: true, sira: 5 }, etiket: { zorunlu: true, sira: 5 }, saticiVergiNo: { zorunlu: true, sira: 99 } });
    expect(keys(receiptRequiredFields(fields, [], form))).toEqual(['faturaNo', 'saticiUnvan', 'saticiVergiNo', 'etiket', 'not']);
  });

  it('requires the targets of a form-level rule on every receipt', () => {
    const rules = [rule('kategori', ARAC_BAKIM, ['etiket', 'projeKodu'])];
    const atForm = { kategoriId: ARAC_BAKIM, masrafMerkeziId: null };
    expect(keys(receiptRequiredFields(FIELDS, rules, atForm))).toEqual(['faturaNo', 'saticiUnvan', 'etiket', 'projeKodu']);
    expect(keys(receiptRequiredFields(FIELDS, rules, atForm, { dokumanTipi: FATURA }))).toEqual(['faturaNo', 'saticiUnvan', 'etiket', 'projeKodu']);
    expect(keys(receiptRequiredFields(FIELDS, rules, form))).toEqual(['faturaNo', 'saticiUnvan']);
  });

  it('requires the targets of a receipt-level rule only on that receipt', () => {
    const rules = [rule('dokumanTipi', FATURA, ['saticiVergiNo', 'not'])];
    expect(keys(receiptRequiredFields(FIELDS, rules, form, { dokumanTipi: FATURA }))).toEqual(['faturaNo', 'saticiUnvan', 'saticiVergiNo', 'not']);
    expect(keys(receiptRequiredFields(FIELDS, rules, form, { dokumanTipi: 1 }))).toEqual(['faturaNo', 'saticiUnvan']);
  });

  it('makes the cost centre required when marked or by a form-level rule, never when inactive', () => {
    expect(formRequiredFields(with_({ masrafMerkezi: { zorunlu: true } }), [], form)).toEqual(['masrafMerkezi']);
    expect(formRequiredFields(with_({ masrafMerkezi: { zorunlu: true, aktif: false } }), [], form)).toEqual([]);
    const byCategory = [rule('kategori', ARAC_BAKIM, ['masrafMerkezi'])];
    expect(formRequiredFields(FIELDS, byCategory, { kategoriId: ARAC_BAKIM, masrafMerkeziId: null })).toEqual(['masrafMerkezi']);
    expect(formRequiredFields(FIELDS, byCategory, form)).toEqual([]);
    // A receipt-level condition never reaches the form (the API refuses such a rule anyway).
    expect(formRequiredFields(FIELDS, [rule('dokumanTipi', FATURA, ['masrafMerkezi'])], form)).toEqual([]);
    // The cost centre is never a receipt field.
    expect(keys(receiptRequiredFields(FIELDS, byCategory, { kategoriId: ARAC_BAKIM, masrafMerkeziId: null }))).not.toContain('masrafMerkezi');
  });

  it('never requires an inactive field, marked or targeted', () => {
    const fields = with_({ etiket: { zorunlu: true, aktif: false }, projeKodu: { aktif: false }, saticiUnvan: { zorunlu: false } });
    const rules = [rule('kategori', ARAC_BAKIM, ['projeKodu'])];
    expect(keys(receiptRequiredFields(fields, rules, { kategoriId: ARAC_BAKIM, masrafMerkeziId: null }))).toEqual(['faturaNo']);
  });

  it('never lists the category', () => {
    expect(requiredFields(FIELDS, [rule('masrafMerkezi', MM_1, ['kategori'])], { kategoriId: 1, masrafMerkeziId: MM_1 })).toEqual({ form: [], fis: ['faturaNo', 'saticiUnvan'] });
  });
});

describe('missingReceiptFields', () => {
  const required = receiptRequiredFields(with_({ etiket: { zorunlu: true }, not: { zorunlu: true } }), [], form);

  it('reads header fields from the effective header and the others from the values', () => {
    const header = sampleInvoice({ faturaNo: '  ', saticiUnvan: 'Örnek' }).fatura;
    expect(missingReceiptFields(required, { etiket: 5, not: ' ' }, header)).toEqual(['faturaNo', 'not']);
    expect(missingReceiptFields(required, { etiket: 5, not: 'yıkama' }, sampleInvoice().fatura)).toEqual([]);
    expect(missingReceiptFields(required, { etiket: null }, sampleInvoice({ saticiUnvan: null }).fatura)).toEqual(['saticiUnvan', 'etiket', 'not']);
  });

  it('leaves header fields out for a file not read yet', () => {
    expect(missingReceiptFields(required, {}, null)).toEqual(['etiket', 'not']);
  });
});

describe('field keys', () => {
  it('turns Turkish names into camelCase ASCII keys', () => {
    expect(keyOfName('Araç Plakası')).toBe('aracPlakasi');
    expect(keyOfName('KKEG Türü')).toBe('kkegTuru');
    expect(keyOfName('Ödeme  Yöntemi')).toBe('odemeYontemi');
    expect(keyOfName('İŞ EMRİ / no.')).toBe('isEmriNo');
    expect(keyOfName('Café crème')).toBe('cafeCreme');
  });

  it('puts "alan" in front of a key that would not start with a letter, and cuts it at 40', () => {
    expect(keyOfName('3. Taraf')).toBe('alan3Taraf');
    expect(keyOfName('!!!')).toBe('alan');
    expect(keyOfName('a'.repeat(50))).toHaveLength(40);
  });

  it('adds 2, 3, … to a taken key, keeping 40 characters', () => {
    expect(newFieldKey('Etiket', new Set(['etiket']))).toBe('etiket2');
    expect(newFieldKey('Etiket', new Set(['etiket', 'etiket2']))).toBe('etiket3');
    const long = 'b'.repeat(40);
    expect(newFieldKey(long, new Set([long]))).toBe(`${'b'.repeat(39)}2`);
  });

  it('treats the names of Object properties as taken', () => {
    expect(newFieldKey('Constructor', new Set())).toBe('constructor2');
    expect(newFieldKey('to String', new Set())).toBe('toString2');
  });
});

describe('editableProps', () => {
  it('follows the group table', () => {
    expect(editableProps({ tur: 'kategori' })).toEqual(['aciklama']);
    expect(editableProps({ tur: 'masraf_merkezi' })).toEqual(['zorunlu', 'aktif', 'aciklama']);
    expect(editableProps({ tur: 'fatura' })).toEqual(['zorunlu', 'aciklama']);
    expect(editableProps({ tur: 'liste' })).toEqual(['ad', 'zorunlu', 'aktif', 'sira', 'aciklama']);
  });
});

describe('receipt values', () => {
  const of = (tur: FieldDef['tur'], raw: unknown) => parseReceiptValue({ ad: 'Alan', tur }, raw);

  it('deletes with null or blank text', () => {
    for (const tur of ['liste', 'metin', 'uzun_metin', 'sayi', 'tarih'] as const) {
      expect(of(tur, null)).toEqual({ ok: true, value: null });
      expect(of(tur, '   ')).toEqual({ ok: true, value: null });
    }
  });

  it('checks each type', () => {
    expect(of('liste', 7)).toEqual({ ok: true, value: { secenekId: 7, metin: null } });
    expect(of('liste', 1.5)).toMatchObject({ ok: false });
    expect(of('liste', '7')).toMatchObject({ ok: false });
    // An option id is an SQL Server int; a larger one is a bad value (400), not a failed query (500).
    expect(of('liste', 2_147_483_647)).toMatchObject({ ok: true });
    expect(of('liste', 2_147_483_648)).toEqual({ ok: false, mesaj: 'Alan için listeden bir seçenek seçin.' });
    expect(of('liste', 3_000_000_000)).toMatchObject({ ok: false });
    expect(of('metin', '  Araç yıkama ')).toEqual({ ok: true, value: { secenekId: null, metin: 'Araç yıkama' } });
    expect(of('metin', 'x'.repeat(201))).toEqual({ ok: false, mesaj: 'Alan en fazla 200 karakter olabilir.' });
    expect(of('uzun_metin', 'x'.repeat(1000))).toMatchObject({ ok: true });
    expect(of('uzun_metin', 'x'.repeat(1001))).toEqual({ ok: false, mesaj: 'Alan en fazla 1000 karakter olabilir.' });
    expect(of('metin', 5)).toEqual({ ok: false, mesaj: 'Alan metin olmalıdır.' });
    expect(of('sayi', 12.5)).toEqual({ ok: true, value: { secenekId: null, metin: '12.5' } });
    expect(of('sayi', '12')).toEqual({ ok: false, mesaj: 'Alan sayı olmalıdır.' });
    expect(of('sayi', Number.POSITIVE_INFINITY)).toMatchObject({ ok: false });
    expect(of('tarih', '2026-02-28')).toEqual({ ok: true, value: { secenekId: null, metin: '2026-02-28' } });
    expect(of('tarih', '2026-02-30')).toMatchObject({ ok: false });
    expect(of('tarih', '28.02.2026')).toMatchObject({ ok: false });
    expect(of('fatura', 'x')).toEqual({ ok: false, mesaj: 'Bu alan fişte kullanılmıyor.' });
  });

  it('shows options by their gösterim and numbers as numbers', () => {
    expect(valueView('liste', { secenekId: 7, metin: null }, 'P1 – Proje')).toEqual({ deger: 7, gosterim: 'P1 – Proje' });
    expect(valueView('sayi', { secenekId: null, metin: '12.5' }, null)).toEqual({ deger: 12.5, gosterim: '12.5' });
    expect(valueView('metin', { secenekId: null, metin: 'Not' }, null)).toEqual({ deger: 'Not', gosterim: 'Not' });
  });

  it('compares stored values', () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue({ secenekId: 1, metin: null }, { secenekId: 1, metin: null })).toBe(true);
    expect(sameValue({ secenekId: 1, metin: null }, { secenekId: 2, metin: null })).toBe(false);
    expect(sameValue({ secenekId: null, metin: 'a' }, null)).toBe(false);
  });
});
