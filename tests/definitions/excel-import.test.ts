// The pure part of a definition list's Excel import (src/definitions/excel-import.ts): which column is
// which field, row checks and what the import would change (docs/onay-sistemi.md, section 6).
import { describe, expect, it } from 'vitest';
import { importResult, keyOf, normalizeHeader, optionHeaders, parseActive, planImport, type ImportSpec, type StoredRow } from '../../src/definitions/excel-import.ts';
import { CATEGORIES, COST_CENTERS, ORGANIZATIONS, optionsOf } from '../../src/definitions/lists.ts';
import type { SheetRow } from '../../src/excel/xlsx.ts';

/** Sheet rows from arrays; the first one is the header (row 1), the others follow from row 2. */
const sheet = (...rows: string[][]): SheetRow[] => rows.map((hucreler, i) => ({ satir: i + 1, hucreler }));
const stored = (id: number, values: StoredRow['values']): StoredRow => ({ id, values });
const plan = (spec: ImportSpec, rows: SheetRow[], existing: StoredRow[] = [], deactivateMissing = false) => planImport(spec, rows, existing, { deactivateMissing });
const fails = (fn: () => unknown, message: RegExp): void => {
  expect(fn).toThrow(message);
  try {
    fn();
  } catch (err) {
    expect(err).toMatchObject({ status: 400, code: 'gecersiz_dosya' });
  }
};

const etiket = optionsOf({ id: 1, anahtar: 'etiket', ad: 'Etiket', aktif: true }).spec;
const proje = optionsOf({ id: 2, anahtar: 'projeKodu', ad: 'Proje Kodu', aktif: true }).spec;

describe('header and value rules', () => {
  it('compares headers without case, spaces, punctuation or Turkish letters', () => {
    expect(normalizeHeader('Proje  Açıklaması')).toBe('projeaciklamasi');
    expect(normalizeHeader('MASRAF MERKEZİ')).toBe('masrafmerkezi');
    expect(normalizeHeader('ŞirketNo')).toBe('sirketno');
    expect(normalizeHeader('Gl Kod-1')).toBe('glkod1');
    expect(normalizeHeader('KDV ORANI')).toBe('kdvorani');
    expect(normalizeHeader('Doğru/Yanlış')).toBe('dogruyanlis');
  });

  it('compares keys like the Turkish collation: i/İ and ı/I pair up', () => {
    expect(keyOf(' istanbul ')).toBe(keyOf('İSTANBUL'));
    expect(keyOf('ılık')).toBe(keyOf('ILIK'));
    expect(keyOf('istanbul')).not.toBe(keyOf('ISTANBUL'));
    // Width-insensitive like the collation, and blind to invisible format characters.
    expect(keyOf('ＭＭ１')).toBe(keyOf('mm1'));
    expect(keyOf('MM​1﻿')).toBe(keyOf('MM1'));
  });

  it('reads the active column in Turkish and English words', () => {
    for (const yes of ['Evet', 'E', 'aktif', '1', 'TRUE', 'Doğru', 'DOĞRU']) expect(parseActive(yes)).toBe(true);
    for (const no of ['Hayır', 'h', 'Pasif', '0', 'false', 'YANLIŞ']) expect(parseActive(no)).toBe(false);
    expect(parseActive('belki')).toBeNull();
  });

  it('names option columns after the field, with and without its trailing "Kodu"', () => {
    const map = (name: string) => new Map(optionHeaders(name).map(([h, f]) => [normalizeHeader(h), f]));
    const e = map('Etiket');
    expect([e.get('etiketadi'), e.get('etiket'), e.get('etiketkodu'), e.get('etiketaciklamasi')]).toEqual(['kod', 'kod', 'kod', 'ad']);
    const p = map('Proje Kodu');
    expect([p.get('projekodu'), p.get('projeaciklamasi'), p.get('projekoduaciklamasi'), p.get('projekoduadi')]).toEqual(['kod', 'ad', 'ad', 'kod']);
    expect(p.has('projekodukodu')).toBe(false);
    expect([p.get('kod'), p.get('ad'), p.get('aciklama'), p.get('durum')]).toEqual(['kod', 'ad', 'ad', 'aktif']);
  });
});

describe('columns', () => {
  it('reads a masraff cost-centre export: code and description, the rest ignored', () => {
    const p = plan(
      COST_CENTERS.spec,
      sheet(['MasrafMerkeziNo', 'ŞirketNo', 'MasrafMerkezi', 'Açıklama', 'GlKod', 'BirinciOnaycı'], ['1', '1000', ' 11033106', '11033106', '', 'kisi@firma.test'], ['2', '1000', '', '', '', '']),
    );
    expect(p.sutunlar).toEqual({ kod: 'MasrafMerkezi', aciklama: 'Açıklama' });
    expect(p.yokSayilanSutunlar).toEqual(['MasrafMerkeziNo', 'ŞirketNo', 'GlKod', 'BirinciOnaycı']);
    expect(p.inserts).toEqual([{ kod: '11033106', aciklama: '11033106', aktif: true }]);
    expect(p.errors).toEqual([{ satir: 3, mesaj: 'Kod boş.' }]);
  });

  it('reads the masraff tag, project and category exports', () => {
    expect(plan(etiket, sheet(['Etiket No', 'Şirket Adı', 'EtiketAdı', 'EtiketAçıklaması'], ['5', 'Şirket', 'P34MHG325', 'P34MHG325-18036470'])).inserts).toEqual([
      { kod: 'P34MHG325', ad: 'P34MHG325-18036470', aktif: true },
    ]);
    expect(plan(proje, sheet(['No', 'Proje Kodu', 'Proje  Açıklaması'], ['1', 'PRJ-1', 'Yeni fabrika'])).sutunlar).toEqual({ kod: 'Proje Kodu', ad: 'Proje  Açıklaması' });
    const k = plan(CATEGORIES.spec, sheet(['Kategori No', 'Şirket Adı', 'Kategori Adı', 'Kategori Kodu', 'Kdv Oranları', 'Gl Kod 1', 'Gl Kod 2'], ['1', 'Şirket', 'ARAÇ BAKIM ONARIM', '', '0, 1, 10, 20', '7609901001', '']));
    expect(k.sutunlar).toEqual({ ad: 'Kategori Adı', kod: 'Kategori Kodu', kdvOranlari: 'Kdv Oranları', hesapKodu: 'Gl Kod 1' });
    expect(k.yokSayilanSutunlar).toEqual(['Kategori No', 'Şirket Adı', 'Gl Kod 2']);
    expect(k.inserts).toEqual([{ ad: 'ARAÇ BAKIM ONARIM', kod: null, kdvOranlari: '0, 1, 10, 20', hesapKodu: '7609901001', simge: 'diger', aktif: true }]);
  });

  it('takes the first of two columns of the same field and ignores the second', () => {
    const p = plan(COST_CENTERS.spec, sheet(['Kod', 'Masraf Merkezi', 'Açıklama'], ['A', 'B', 'x']));
    expect(p.sutunlar).toEqual({ kod: 'Kod', aciklama: 'Açıklama' });
    expect(p.yokSayilanSutunlar).toEqual(['Masraf Merkezi']);
    expect(p.inserts[0]?.kod).toBe('A');
  });

  it('refuses a file without its key column, naming the expected headers', () => {
    fails(() => plan(COST_CENTERS.spec, sheet(['Açıklama', 'Aktif'], ['x', 'Evet'])), /kod sütunu bulunamadı. Beklenen başlıklardan biri: Kod, Masraf Merkezi, Masraf Merkezi Kodu\./);
    fails(() => plan(CATEGORIES.spec, sheet(['Kategori Kodu'], ['x'])), /kategori adı sütunu bulunamadı/);
    fails(() => plan(proje, sheet(['Açıklama'], ['x'])), /Beklenen başlıklardan biri: Kod, Proje Kodu, Proje Kodu Adı\./);
    fails(() => plan(COST_CENTERS.spec, []), /başlık satırı/);
  });
});

describe('rows', () => {
  it('reports bad rows with their Excel row numbers and applies the good ones', () => {
    const rows: SheetRow[] = [
      { satir: 1, hucreler: ['Organizasyon Kodu', 'Organizasyon Adı', 'Para Birimi', 'Aktif'] },
      { satir: 2, hucreler: ['1000', 'Şenpiliç Gıda', 'try', 'Evet'] },
      { satir: 4, hucreler: ['2000', '', 'USD', ''] },
      { satir: 5, hucreler: ['3000', 'Üçüncü', 'TL', 'belki'] },
      { satir: 6, hucreler: ['1000', 'Tekrar', '', ''] },
      { satir: 7, hucreler: ['K'.repeat(51), 'Uzun', '', ''] },
      { satir: 8, hucreler: ['4000', 'Dördüncü', '', 'Hayır'] },
    ];
    const p = plan(ORGANIZATIONS.spec, rows);
    expect(p.inserts).toEqual([
      { kod: '1000', ad: 'Şenpiliç Gıda', paraBirimi: 'TRY', aktif: true },
      { kod: '4000', ad: 'Dördüncü', paraBirimi: null, aktif: false },
    ]);
    expect(p.errors).toEqual([
      { satir: 4, mesaj: 'Organizasyon adı boş.' },
      { satir: 5, mesaj: 'Para birimi geçersiz: "TL" (üç harfli ISO kodu olmalıdır, ör. TRY). Aktif değeri geçersiz: "belki" (Evet ya da Hayır yazın).' },
      { satir: 6, mesaj: 'Bu kod dosyada 2. satırda da var.' },
      { satir: 7, mesaj: 'Kod en fazla 50 karakter olabilir.' },
    ]);
    expect(importResult(p, true)).toMatchObject({ onizleme: true, satirSayisi: 6, eklenen: 2, guncellenen: 0, degismeyen: 0, pasiflestirilen: 0, hataSayisi: 4 });
  });

  it('finds duplicates without case and surrounding spaces, Turkish rules', () => {
    const p = plan(COST_CENTERS.spec, sheet(['Kod'], ['istanbul'], [' İSTANBUL '], ['ISTANBUL']));
    expect(p.inserts.map((r) => r.kod)).toEqual(['istanbul', 'ISTANBUL']);
    expect(p.errors).toEqual([{ satir: 3, mesaj: 'Bu kod dosyada 2. satırda da var.' }]);
  });

  it('checks the icon of a category and gives a new one "diger" when empty', () => {
    const p = plan(CATEGORIES.spec, sheet(['Ad', 'Simge'], ['Yemek dışı', 'YEMEK'], ['Taksi', ''], ['Uçak', 'roket']));
    expect(p.inserts.map((r) => [r.ad, r.simge])).toEqual([
      ['Yemek dışı', 'yemek'],
      ['Taksi', 'diger'],
    ]);
    expect(p.errors[0]?.mesaj).toMatch(/^Simge geçersiz: "roket". Geçerli değerler: yemek, ulasim/);
  });

  it('needs the name of a new organisation even when the file has no name column', () => {
    const existing = [stored(1, { kod: '1000', ad: 'Var olan', paraBirimi: null, aktif: true })];
    const p = plan(ORGANIZATIONS.spec, sheet(['Kod', 'Para Birimi'], ['1000', 'EUR'], ['2000', 'EUR']), existing);
    expect(p.updates).toEqual([{ id: 1, values: { kod: '1000', ad: 'Var olan', paraBirimi: 'EUR', aktif: true } }]);
    expect(p.errors).toEqual([{ satir: 3, mesaj: 'Organizasyon adı boş.' }]);
  });

  it('caps the reported errors at 100 but counts them all', () => {
    const rows = sheet(['Kod', 'Açıklama'], ...Array.from({ length: 150 }, () => ['', 'kodsuz']));
    const r = importResult(plan(COST_CENTERS.spec, rows), true);
    expect(r.hataSayisi).toBe(150);
    expect(r.hatalar).toHaveLength(100);
    expect(r.hatalar[99]).toEqual({ satir: 101, mesaj: 'Kod boş.' });
  });
});

describe('matching stored rows', () => {
  const existing = [
    stored(1, { kod: 'MM1', aciklama: 'Bir', aktif: true }),
    stored(2, { kod: 'mm2', aciklama: null, aktif: false }),
    stored(3, { kod: 'MM3', aciklama: 'Üç', aktif: true }),
    stored(4, { kod: 'MM4', aciklama: 'Dört', aktif: true }),
  ];

  it('updates only the columns in the file, takes the file spelling of the key and counts unchanged rows', () => {
    const p = plan(COST_CENTERS.spec, sheet(['Kod', 'Aktif'], ['mm1', ''], ['MM2', ''], ['MM3', 'Evet'], ['MM5', '']), existing);
    expect(p.updates).toEqual([
      { id: 1, values: { kod: 'mm1', aciklama: 'Bir', aktif: true } },
      { id: 2, values: { kod: 'MM2', aciklama: null, aktif: false } },
    ]);
    expect(p.unchanged).toBe(1);
    expect(p.inserts).toEqual([{ kod: 'MM5', aciklama: null, aktif: true }]);
    expect(p.deactivate).toEqual([]);
  });

  it('clears a description with an empty cell, and leaves an inactive row inactive when Aktif is empty', () => {
    const p = plan(COST_CENTERS.spec, sheet(['Kod', 'Açıklama', 'Aktif'], ['MM1', '', ''], ['MM2', 'İki', '']), existing);
    expect(p.updates).toEqual([
      { id: 1, values: { kod: 'MM1', aciklama: null, aktif: true } },
      { id: 2, values: { kod: 'MM2', aciklama: 'İki', aktif: false } },
    ]);
  });

  it('deactivates active rows the file does not name; an erroneous row still names its key', () => {
    const rows = sheet(['Kod', 'Açıklama'], ['MM1', 'Bir'], ['mm3', 'A'.repeat(201)]);
    const p = plan(COST_CENTERS.spec, rows, existing, true);
    expect(p.deactivate).toEqual([4]);
    expect(p.errors).toEqual([{ satir: 3, mesaj: 'Açıklama en fazla 200 karakter olabilir.' }]);
    expect(importResult(p, false)).toMatchObject({ onizleme: false, degismeyen: 1, pasiflestirilen: 1, hataSayisi: 1 });
    expect(plan(COST_CENTERS.spec, rows, existing, false).deactivate).toEqual([]);
  });

  it('refuses to deactivate with a file that names no key, which would deactivate the whole list', () => {
    for (const rows of [sheet(['Kod', 'Açıklama'], ['', 'Bir'], ['  ', 'İki']), sheet(['Kod'])]) {
      expect(() => plan(COST_CENTERS.spec, rows, existing, true)).toThrow(/hiçbir satırda kod yok/);
      expect(plan(COST_CENTERS.spec, rows, existing, false).deactivate).toEqual([]);
    }
  });

  it('matches categories by name', () => {
    const cats = [stored(9, { ad: 'Yemek', kod: null, kdvOranlari: null, hesapKodu: null, simge: 'yemek', aktif: true })];
    const p = plan(CATEGORIES.spec, sheet(['Kategori Adı', 'Kategori Kodu', 'Simge'], ['YEMEK', 'Y1', '']), cats);
    expect(p.updates).toEqual([{ id: 9, values: { ad: 'YEMEK', kod: 'Y1', kdvOranlari: null, hesapKodu: null, simge: 'yemek', aktif: true } }]);
  });
});
