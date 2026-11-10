// The definition-list service against the test database (src/definitions/lists.ts): what the HTTP tests
// cannot easily show, such as two imports at once and a field that goes away under an import.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { p, queryOne, type Db } from '../../src/db/sql.ts';
import { COST_CENTERS, createRecord, exportList, findListField, importList, listRecords, optionsOf } from '../../src/definitions/lists.ts';
import { readXlsx, writeXlsx } from '../../src/excel/xlsx.ts';
import type { Kullanici } from '../../src/users/users.ts';
import { closeTestDb, fieldId, makeUser, resetDb, testDb } from '../db.ts';

const APPLY = { preview: false, deactivateMissing: false } as const;
const sheet = (header: string[], ...rows: string[][]): Buffer => writeXlsx({ name: 'Sayfa1', header, rows });

describe('definition lists', () => {
  let db: Db;
  let admin: Kullanici;

  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await resetDb(db);
    admin = await makeUser(db, { rol: 'yonetici' });
  });

  it('runs two imports of one list one after the other, so the second sees what the first added', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => [`MM${i}`, `Merkez ${i}`]);
    const file = sheet(['Kod', 'Açıklama'], ...rows);
    const [first, second] = await Promise.all([importList(db, admin, COST_CENTERS, file, APPLY), importList(db, admin, COST_CENTERS, file, APPLY)]);
    expect([first.eklenen, second.eklenen].sort()).toEqual([0, 300]);
    expect([first.degismeyen, second.degismeyen].sort()).toEqual([0, 300]);
    expect((await listRecords(db, COST_CENTERS, { sayfa: 1, adet: 1 })).toplam).toBe(300);
  });

  it('keeps the options of each field apart', async () => {
    const etiket = optionsOf(await findListField(db, 'etiket', true));
    const proje = optionsOf(await findListField(db, 'projeKodu', true));
    await importList(db, admin, etiket, sheet(['Kod'], ['ORTAK'], ['E1']), APPLY);
    expect((await importList(db, admin, proje, sheet(['Kod'], ['ortak']), APPLY)).eklenen).toBe(1);
    expect(readXlsx((await exportList(db, etiket)).file).map((r) => r.hucreler[0])).toEqual(['Kod', 'ORTAK', 'E1']);
    expect((await listRecords(db, proje, { sayfa: 1, adet: 10 })).kayitlar.map((s) => s.kod)).toEqual(['ortak']);
    expect((await exportList(db, proje)).fileName).toMatch(/^Proje Kodu_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('answers 404 when the field of the options is gone', async () => {
    const field = await findListField(db, 'kkegTuru', true);
    await queryOne(db, 'DELETE FROM dbo.alan_tanimlari OUTPUT deleted.id WHERE id = @id', { id: p.int(field.id) });
    await expect(importList(db, admin, optionsOf(field), sheet(['Kod'], ['X']), APPLY)).rejects.toMatchObject({ status: 404 });
    await expect(createRecord(db, admin, optionsOf(field), { kod: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(findListField(db, 'kkegTuru', true)).rejects.toMatchObject({ status: 404 });
  });

  it('finds only list fields, and inactive ones only for administrators', async () => {
    await expect(findListField(db, 'not', true)).rejects.toMatchObject({ status: 404 });
    await expect(findListField(db, 'masrafMerkezi', true)).rejects.toMatchObject({ status: 404 });
    await queryOne(db, `UPDATE dbo.alan_tanimlari SET aktif = 0 OUTPUT inserted.id WHERE anahtar = 'etiket'`);
    await expect(findListField(db, 'etiket', false)).rejects.toMatchObject({ status: 404 });
    expect(await findListField(db, 'etiket', true)).toEqual({ id: await fieldId(db, 'etiket'), anahtar: 'etiket', ad: 'Etiket', aktif: false });
  });
});
