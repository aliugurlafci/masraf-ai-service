// Field definitions and required-field rules (docs/onay-sistemi.md, section 3, "Fiş alanları, masraf
// merkezi ve zorunluluk kuralları", and section 6, "Fiş alanları"). The rules themselves are pure
// (src/expenses/field-rules.ts); this module reads and writes them. Changes are serialised with an
// application lock, as the approval flows are, and each one is written to the audit log.
import { audit } from '../db/audit.ts';
import { execute, isUniqueViolation, p, query, queryOne, SQL_ERROR, sqlErrorNumber, transaction, type Db, type Executor } from '../db/sql.ts';
import { conflict, HttpError, notFound } from '../errors.ts';
import {
  CATEGORY_KEY,
  editableProps,
  MAX_RECEIPT_FIELDS,
  newFieldKey,
  type AlanTuru,
  type Duzey,
  type FieldDef,
  type FieldProp,
  type FieldRule,
  type FisAlanTuru,
} from '../expenses/field-rules.ts';
import type { Actor } from '../expenses/rules.ts';
import { display } from './display.ts';
import { lockList } from './list-tx.ts';

/** A field as the API shows it (AlanTanimi). */
export interface AlanTanimi {
  readonly id: number;
  readonly anahtar: string;
  readonly ad: string;
  readonly duzey: Duzey;
  readonly tur: AlanTuru;
  readonly zorunlu: boolean;
  readonly aktif: boolean;
  readonly sira: number;
  readonly sistem: boolean;
  readonly aciklama: string | null;
  /** Active options of a 'liste' field; null for the other types. */
  readonly secenekSayisi: number | null;
  /** Only in the administrator's full list: receipts holding a value of this field. */
  readonly kullanim?: number;
}

/** A rule as the API shows it (AlanKurali). */
export interface AlanKurali {
  readonly id: number;
  readonly kosulAlan: string;
  readonly kosulDeger: { readonly id: number; readonly gosterim: string; readonly aktif: boolean };
  readonly hedefler: readonly string[];
}

/** Every field and every rule, inactive ones included, for the required-field calculation. */
export interface Definitions {
  readonly fields: readonly FieldDef[];
  readonly rules: readonly FieldRule[];
}

export interface NewField {
  readonly ad: string;
  readonly tur: FisAlanTuru;
  readonly zorunlu?: boolean | undefined;
  readonly aciklama?: string | null | undefined;
}

/**
 * A change of a field. The properties a field never changes (tur, anahtar, duzey, sistem) may be sent
 * with their current value; a different value is refused like a property its group cannot change.
 */
export interface FieldPatch {
  readonly ad?: string | undefined;
  readonly zorunlu?: boolean | undefined;
  readonly aktif?: boolean | undefined;
  readonly sira?: number | undefined;
  readonly aciklama?: string | null | undefined;
  readonly tur?: unknown;
  readonly anahtar?: unknown;
  readonly duzey?: unknown;
  readonly sistem?: unknown;
}

export interface RuleInput {
  readonly kosulAlan: string;
  readonly kosulDegerId: number;
  readonly hedefler: readonly string[];
}

interface FieldRow {
  id: number;
  anahtar: string;
  ad: string;
  duzey: Duzey;
  tur: AlanTuru;
  zorunlu: boolean;
  aktif: boolean;
  sira: number;
  sistem: boolean;
  aciklama: string | null;
  secenek_sayisi: number | null;
  kullanim?: number;
}

interface RuleRow {
  id: number;
  kosul_alan: string;
  kosul_tur: AlanTuru;
  kosul_deger_id: number;
  k_ad: string | null;
  k_aktif: boolean | null;
  m_kod: string | null;
  m_aciklama: string | null;
  m_aktif: boolean | null;
  s_kod: string | null;
  s_ad: string | null;
  s_aktif: boolean | null;
}

interface TargetRow {
  kural_id: number;
  anahtar: string;
  aktif: boolean;
}

/** Form fields first, then by sira and id (section 6, "Fiş alanları"). */
const FIELD_ORDER = `CASE a.duzey WHEN 'form' THEN 0 ELSE 1 END, a.sira, a.id`;

const fieldSelect = (withUse: boolean): string => `SELECT a.id, a.anahtar, a.ad, a.duzey, a.tur, a.zorunlu, a.aktif, a.sira, a.sistem, a.aciklama,
    CASE WHEN a.tur = 'liste' THEN (SELECT COUNT(*) FROM dbo.alan_secenekleri s WHERE s.alan_id = a.id AND s.aktif = 1) END AS secenek_sayisi
    ${withUse ? `, (SELECT COUNT(*) FROM dbo.fis_alan_degerleri v WHERE v.alan_id = a.id) + (SELECT COUNT(*) FROM dbo.bekleyen_alan_degerleri v WHERE v.alan_id = a.id) AS kullanim` : ''}
  FROM dbo.alan_tanimlari a`;

// The condition value is a row of the list the condition field takes its values from.
const RULE_SELECT = `SELECT r.id, a.anahtar AS kosul_alan, a.tur AS kosul_tur, r.kosul_deger_id,
    k.ad AS k_ad, k.aktif AS k_aktif, m.kod AS m_kod, m.aciklama AS m_aciklama, m.aktif AS m_aktif, s.kod AS s_kod, s.ad AS s_ad, s.aktif AS s_aktif
  FROM dbo.alan_kurallari r
  JOIN dbo.alan_tanimlari a ON a.id = r.kosul_alan_id
  LEFT JOIN dbo.masraf_kategorileri k ON a.tur = 'kategori' AND k.id = r.kosul_deger_id
  LEFT JOIN dbo.masraf_merkezleri m ON a.tur = 'masraf_merkezi' AND m.id = r.kosul_deger_id
  LEFT JOIN dbo.alan_secenekleri s ON a.tur = 'liste' AND s.alan_id = a.id AND s.id = r.kosul_deger_id`;

const TARGET_SELECT = `SELECT h.kural_id, a.anahtar, a.aktif FROM dbo.alan_kurali_hedefleri h JOIN dbo.alan_tanimlari a ON a.id = h.alan_id`;

/** Serialises changes of fields and rules, so two administrators cannot pass the same check at once. */
export async function lockFields(ex: Executor): Promise<void> {
  const row = await queryOne<{ rc: number }>(
    ex,
    `DECLARE @rc INT;
     EXEC @rc = sp_getapplock @Resource = N'masraf_alanlar', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 15000;
     SELECT @rc AS rc;`,
  );
  if (row === null || row.rc < 0) throw new Error(`alan tanımları kilitlenemedi (${row?.rc ?? '?'})`);
}

const toDef = (r: FieldRow): FieldDef => ({ id: r.id, anahtar: r.anahtar, ad: r.ad, duzey: r.duzey, tur: r.tur, zorunlu: r.zorunlu, aktif: r.aktif, sira: r.sira });

function toField(r: FieldRow, withUse: boolean): AlanTanimi {
  return {
    ...toDef(r),
    sistem: r.sistem,
    aciklama: r.aciklama,
    secenekSayisi: r.tur === 'liste' ? (r.secenek_sayisi ?? 0) : null,
    ...(withUse ? { kullanim: r.kullanim ?? 0 } : {}),
  };
}

/** The condition value as shown: a category by its name, a cost centre or an option by its gösterim. */
function conditionValue(r: RuleRow): AlanKurali['kosulDeger'] {
  if (r.kosul_tur === 'kategori' && r.k_ad !== null) return { id: r.kosul_deger_id, gosterim: r.k_ad, aktif: r.k_aktif === true };
  if (r.kosul_tur === 'masraf_merkezi' && r.m_kod !== null) return { id: r.kosul_deger_id, gosterim: display(r.m_kod, r.m_aciklama), aktif: r.m_aktif === true };
  if (r.kosul_tur === 'liste' && r.s_kod !== null) return { id: r.kosul_deger_id, gosterim: display(r.s_kod, r.s_ad), aktif: r.s_aktif === true };
  // The value is gone (its list removed it without the rule); the rule can never apply but stays deletable.
  return { id: r.kosul_deger_id, gosterim: `#${r.kosul_deger_id}`, aktif: false };
}

const toRule = (r: RuleRow, targets: readonly TargetRow[]): AlanKurali => ({
  id: r.id,
  kosulAlan: r.kosul_alan,
  kosulDeger: conditionValue(r),
  hedefler: targets.filter((t) => t.kural_id === r.id).map((t) => t.anahtar),
});

/** Every field and rule (inactive ones too); what the form service computes required fields from. */
export async function loadDefinitions(ex: Executor): Promise<Definitions> {
  const fields = await query<FieldRow>(ex, `${fieldSelect(false)} ORDER BY ${FIELD_ORDER}`);
  const rules = await query<{ id: number; kosul_alan: string; kosul_deger_id: number }>(
    ex,
    'SELECT r.id, a.anahtar AS kosul_alan, r.kosul_deger_id FROM dbo.alan_kurallari r JOIN dbo.alan_tanimlari a ON a.id = r.kosul_alan_id ORDER BY r.id',
  );
  const targets = await query<TargetRow>(ex, `${TARGET_SELECT} ORDER BY h.kural_id, ${FIELD_ORDER}`);
  return {
    fields: fields.map(toDef),
    rules: rules.map((r) => ({
      id: r.id,
      kosulAlan: r.kosul_alan,
      kosulDegerId: r.kosul_deger_id,
      hedefler: targets.filter((t) => t.kural_id === r.id).map((t) => t.anahtar),
    })),
  };
}

/**
 * GET /api/alanlar. `all` (administrators only): inactive fields too, with their use, and every rule
 * as it is. Otherwise only active fields, and only the rules whose condition field is active, with their
 * targets narrowed to active fields; a rule left without a target is not shown.
 */
export async function listFields(db: Db, all: boolean): Promise<{ alanlar: AlanTanimi[]; kurallar: AlanKurali[] }> {
  const active = all ? '' : 'WHERE a.aktif = 1';
  const [fields, rules, targets] = await Promise.all([
    query<FieldRow>(db, `${fieldSelect(all)} ${active} ORDER BY ${FIELD_ORDER}`),
    query<RuleRow>(db, `${RULE_SELECT} ${active} ORDER BY ${FIELD_ORDER}, r.id`),
    query<TargetRow>(db, `${TARGET_SELECT} ${active} ORDER BY h.kural_id, ${FIELD_ORDER}`),
  ]);
  return {
    alanlar: fields.map((f) => toField(f, all)),
    kurallar: rules.map((r) => toRule(r, targets)).filter((r) => r.hedefler.length > 0),
  };
}

async function fieldRow(ex: Executor, id: number): Promise<FieldRow | null> {
  return queryOne<FieldRow>(ex, `${fieldSelect(false)} WHERE a.id = @id`, { id: p.int(id) });
}

async function ruleView(ex: Executor, id: number): Promise<AlanKurali | null> {
  const row = await queryOne<RuleRow>(ex, `${RULE_SELECT} WHERE r.id = @id`, { id: p.int(id) });
  if (row === null) return null;
  const targets = await query<TargetRow>(ex, `${TARGET_SELECT} WHERE h.kural_id = @id ORDER BY ${FIELD_ORDER}`, { id: p.int(id) });
  return toRule(row, targets);
}

const fieldError = (alanlar: Record<string, string>): HttpError => {
  const first = Object.values(alanlar)[0] ?? 'İstek geçersiz.';
  return new HttpError(400, 'gecersiz_istek', first, { alanlar });
};

const nameTaken = (): HttpError => conflict('alan_adi_kullaniliyor', 'Bu adla bir alan zaten var.');

async function checkName(ex: Executor, ad: string, selfId: number | null): Promise<void> {
  // The column's Turkish case-insensitive collation compares the names.
  const hit = await queryOne(ex, 'SELECT TOP (1) 1 AS x FROM dbo.alan_tanimlari WHERE ad = @ad AND (@self IS NULL OR id <> @self)', {
    ad: p.str(ad, 60),
    self: p.int(selfId),
  });
  if (hit !== null) throw nameTaken();
}

/** POST /api/alanlar: a new receipt field, at the end of the receipt fields. */
export async function createField(db: Db, actor: Actor, input: NewField): Promise<AlanTanimi> {
  const ad = input.ad.trim();
  try {
    return await transaction(db, async (tx) => {
      await lockFields(tx);
      const count = await queryOne<{ n: number }>(tx, `SELECT COUNT(*) AS n FROM dbo.alan_tanimlari WHERE duzey = 'fis' AND tur <> 'fatura'`);
      if ((count?.n ?? 0) >= MAX_RECEIPT_FIELDS) {
        throw conflict('alan_siniri', `En fazla ${MAX_RECEIPT_FIELDS} fiş alanı tanımlanabilir (pasifler dahil). Kullanılmayan bir alanı silin.`);
      }
      await checkName(tx, ad, null);
      const keys = await query<{ anahtar: string }>(tx, 'SELECT anahtar FROM dbo.alan_tanimlari');
      const anahtar = newFieldKey(ad, new Set(keys.map((k) => k.anahtar)));
      const row = await queryOne<{ id: number }>(
        tx,
        `INSERT INTO dbo.alan_tanimlari (anahtar, ad, duzey, tur, zorunlu, sira, aciklama)
         OUTPUT inserted.id
         VALUES (@k, @ad, 'fis', @tur, @z, (SELECT ISNULL(MAX(sira), 0) + 1 FROM dbo.alan_tanimlari WHERE duzey = 'fis'), @ac)`,
        {
          k: p.ascii(anahtar, 40),
          ad: p.str(ad, 60),
          tur: p.ascii(input.tur, 16),
          z: p.bit(input.zorunlu === true),
          ac: p.str(input.aciklama?.trim() || null, 200),
        },
      );
      if (row === null) throw new Error('alan eklenemedi');
      await audit(tx, actor.id, 'alan_olusturuldu', `${ad} (${anahtar}, ${input.tur}${input.zorunlu === true ? ', zorunlu' : ''})`);
      return toField((await fieldRow(tx, row.id)) as FieldRow, false);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

const PROP_TEXT: Readonly<Record<FieldProp | 'tur' | 'anahtar' | 'duzey' | 'sistem', string>> = {
  ad: 'adı',
  zorunlu: 'zorunluluğu',
  aktif: 'durumu',
  sira: 'sırası',
  aciklama: 'açıklaması',
  tur: 'türü',
  anahtar: 'anahtarı',
  duzey: 'düzeyi',
  sistem: 'sistem alanı olması',
};

const yesNo = (b: boolean): string => (b ? 'evet' : 'hayır');

/** PATCH /api/alanlar/:id: only what the field's group allows (section 3, the group table) may change. */
export async function updateField(db: Db, actor: Actor, id: number, patch: FieldPatch): Promise<AlanTanimi> {
  try {
    return await transaction(db, async (tx) => {
      await lockFields(tx);
      const f = await fieldRow(tx, id);
      if (f === null) throw notFound('Alan bulunamadı.');
      const next = {
        ad: patch.ad?.trim(),
        zorunlu: patch.zorunlu,
        aktif: patch.aktif,
        sira: patch.sira,
        aciklama: patch.aciklama === undefined ? undefined : patch.aciklama?.trim() || null,
      };
      const current: Record<FieldProp, string | number | boolean | null> = { ad: f.ad, zorunlu: f.zorunlu, aktif: f.aktif, sira: f.sira, aciklama: f.aciklama };
      const changed = (Object.keys(next) as FieldProp[]).filter((k) => next[k] !== undefined && next[k] !== current[k]);
      const refused: Record<string, string> = {};
      const allowed = editableProps(f);
      for (const k of changed) if (!allowed.includes(k)) refused[k] = `Bu alanın ${PROP_TEXT[k]} değiştirilemez.`;
      const fixed = { tur: f.tur, anahtar: f.anahtar, duzey: f.duzey, sistem: f.sistem };
      for (const k of ['tur', 'anahtar', 'duzey', 'sistem'] as const) {
        if (patch[k] !== undefined && patch[k] !== fixed[k]) refused[k] = `Bu alanın ${PROP_TEXT[k]} değiştirilemez.`;
      }
      if (Object.keys(refused).length > 0) throw fieldError(refused);
      if (changed.length === 0) return toField(f, false);
      if (next.ad !== undefined && changed.includes('ad')) await checkName(tx, next.ad, f.id);
      const columns: Record<FieldProp, string> = { ad: 'ad = @ad', zorunlu: 'zorunlu = @z', aktif: 'aktif = @ak', sira: 'sira = @s', aciklama: 'aciklama = @ac' };
      await execute(tx, `UPDATE dbo.alan_tanimlari SET ${changed.map((k) => columns[k]).join(', ')} WHERE id = @id`, {
        id: p.int(f.id),
        ad: p.str(next.ad ?? f.ad, 60),
        z: p.bit(next.zorunlu ?? f.zorunlu),
        ak: p.bit(next.aktif ?? f.aktif),
        s: p.int(next.sira ?? f.sira),
        ac: p.str(next.aciklama === undefined ? f.aciklama : next.aciklama, 200),
      });
      const notes = changed.map((k) => {
        switch (k) {
          case 'ad':
            return `ad: ${f.ad} → ${next.ad}`;
          case 'zorunlu':
            return `zorunlu: ${yesNo(next.zorunlu === true)}`;
          case 'aktif':
            return `aktif: ${yesNo(next.aktif === true)}`;
          case 'sira':
            return `sıra: ${next.sira}`;
          case 'aciklama':
            return 'açıklama';
        }
      });
      await audit(tx, actor.id, 'alan_guncellendi', `${f.ad} (${f.anahtar}): ${notes.join(', ')}`);
      return toField((await fieldRow(tx, f.id)) as FieldRow, false);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

const fieldInUse = (): HttpError => conflict('alan_kullaniliyor', 'Bu alana değer girilmiş fişler var; alan silinemez. Silmek yerine pasifleştirin.');

/**
 * DELETE /api/alanlar/:id: a receipt field no receipt holds a value of. Its options go with it, and so
 * do the rules it is the condition of; it leaves the rules it is a target of, and a rule left without
 * targets is deleted.
 */
export async function deleteField(db: Db, actor: Actor, id: number): Promise<void> {
  try {
    await transaction(db, async (tx) => {
      await lockFields(tx);
      // Also the lock of the field's option list: an option delete holds it while it locks this field's row
      // and deletes the rules whose condition is that option, which this delete removes too. Taking it first
      // makes the two wait for each other instead of deadlocking. List writers never take the fields lock.
      await lockList(tx, `secenek_${id}`);
      const f = await fieldRow(tx, id);
      if (f === null) throw notFound('Alan bulunamadı.');
      if (f.sistem) throw conflict('sistem_alani', 'Bu bir sistem alanıdır; silinemez.');
      const used = await queryOne<{ used: number }>(
        tx,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.fis_alan_degerleri WHERE alan_id = @id)
                       OR EXISTS (SELECT 1 FROM dbo.bekleyen_alan_degerleri WHERE alan_id = @id) THEN 1 ELSE 0 END AS used`,
        { id: p.int(id) },
      );
      if (used?.used === 1) throw fieldInUse();
      const targetOf = await query<{ kural_id: number }>(tx, 'SELECT kural_id FROM dbo.alan_kurali_hedefleri WHERE alan_id = @id', { id: p.int(id) });
      await execute(tx, 'DELETE FROM dbo.alan_kurallari WHERE kosul_alan_id = @id', { id: p.int(id) });
      await execute(tx, 'DELETE FROM dbo.alan_kurali_hedefleri WHERE alan_id = @id', { id: p.int(id) });
      for (const { kural_id } of targetOf) {
        await execute(tx, 'DELETE FROM dbo.alan_kurallari WHERE id = @r AND NOT EXISTS (SELECT 1 FROM dbo.alan_kurali_hedefleri WHERE kural_id = @r)', {
          r: p.int(kural_id),
        });
      }
      await execute(tx, 'DELETE FROM dbo.alan_tanimlari WHERE id = @id', { id: p.int(id) });
      await audit(tx, actor.id, 'alan_silindi', `${f.ad} (${f.anahtar})`);
    });
  } catch (err) {
    // A value entered meanwhile (the foreign key from the value tables).
    if (sqlErrorNumber(err) === SQL_ERROR.foreignKey) throw fieldInUse();
    throw err;
  }
}

/** A rule checked against the definitions: its condition field and value, and its targets. */
interface CheckedRule {
  readonly condition: FieldRow;
  readonly value: string;
  readonly targets: FieldRow[];
}

/**
 * The rule checks of section 6 ("Kural doğrulaması"). The condition value's row is locked until the
 * transaction ends, so it cannot be deleted while the rule is written.
 */
async function checkRule(ex: Executor, input: RuleInput, selfId: number | null): Promise<CheckedRule> {
  const fields = await query<FieldRow>(ex, `${fieldSelect(false)} ORDER BY ${FIELD_ORDER}`);
  const byKey = new Map(fields.map((f) => [f.anahtar, f]));
  const condition = byKey.get(input.kosulAlan);
  const usable = condition !== undefined && (condition.tur === 'kategori' || condition.tur === 'masraf_merkezi' || (condition.duzey === 'fis' && condition.tur === 'liste'));
  if (!usable) throw fieldError({ kosulAlan: 'Koşul alanı kategori, masraf merkezi ya da liste türünde bir fiş alanı olmalıdır.' });
  const params = { d: p.int(input.kosulDegerId), a: p.int(condition.id) };
  let value: string | null = null;
  if (condition.tur === 'kategori') {
    const r = await queryOne<{ ad: string }>(ex, 'SELECT ad FROM dbo.masraf_kategorileri WITH (UPDLOCK, ROWLOCK) WHERE id = @d', params);
    value = r?.ad ?? null;
  } else if (condition.tur === 'masraf_merkezi') {
    const r = await queryOne<{ kod: string; aciklama: string | null }>(ex, 'SELECT kod, aciklama FROM dbo.masraf_merkezleri WITH (UPDLOCK, ROWLOCK) WHERE id = @d', params);
    value = r === null ? null : display(r.kod, r.aciklama);
  } else {
    const r = await queryOne<{ kod: string; ad: string | null }>(ex, 'SELECT kod, ad FROM dbo.alan_secenekleri WITH (UPDLOCK, ROWLOCK) WHERE id = @d AND alan_id = @a', params);
    value = r === null ? null : display(r.kod, r.ad);
  }
  const problems: Record<string, string> = {};
  if (value === null) problems.kosulDegerId = 'Bu kayıt koşul alanının listesinde yok.';
  const targets: FieldRow[] = [];
  input.hedefler.forEach((key, i) => {
    const target = byKey.get(key);
    const path = `hedefler.${i}`;
    if (target === undefined) problems[path] = 'Bu alan bulunamadı.';
    else if (target.anahtar === CATEGORY_KEY) problems[path] = 'Kategori her zaman zorunludur; kuralın hedefi olamaz.';
    else if (target.id === condition.id) problems[path] = 'Alan kendi kuralının hedefi olamaz.';
    else if (condition.duzey === 'fis' && target.duzey !== 'fis') problems[path] = 'Fiş alanına bağlı bir kuralın hedefleri fiş alanı olmalıdır.';
    else targets.push(target);
  });
  if (Object.keys(problems).length > 0) throw fieldError(problems);
  const other = await queryOne(
    ex,
    'SELECT TOP (1) 1 AS x FROM dbo.alan_kurallari WHERE kosul_alan_id = @a AND kosul_deger_id = @d AND (@self IS NULL OR id <> @self)',
    { ...params, self: p.int(selfId) },
  );
  if (other !== null) throw ruleExists();
  return { condition, value: value as string, targets };
}

const ruleExists = (): HttpError => conflict('kural_var', 'Bu koşul değeri için zaten bir kural var; o kuralı düzenleyin.');

async function writeTargets(ex: Executor, ruleId: number, targets: readonly FieldRow[]): Promise<void> {
  await execute(ex, 'DELETE FROM dbo.alan_kurali_hedefleri WHERE kural_id = @r', { r: p.int(ruleId) });
  await execute(
    ex,
    `INSERT INTO dbo.alan_kurali_hedefleri (kural_id, alan_id) VALUES ${targets.map((_, i) => `(@r, @t${i})`).join(', ')}`,
    { r: p.int(ruleId), ...Object.fromEntries(targets.map((t, i) => [`t${i}`, p.int(t.id)])) },
  );
}

const ruleText = (c: CheckedRule): string => `${c.condition.ad} = ${c.value} → ${c.targets.map((t) => t.ad).join(', ')}`;

/** POST /api/alan-kurallari. */
export async function createRule(db: Db, actor: Actor, input: RuleInput): Promise<AlanKurali> {
  try {
    return await transaction(db, async (tx) => {
      await lockFields(tx);
      const checked = await checkRule(tx, input, null);
      const row = await queryOne<{ id: number }>(tx, 'INSERT INTO dbo.alan_kurallari (kosul_alan_id, kosul_deger_id) OUTPUT inserted.id VALUES (@a, @d)', {
        a: p.int(checked.condition.id),
        d: p.int(input.kosulDegerId),
      });
      if (row === null) throw new Error('kural eklenemedi');
      await writeTargets(tx, row.id, checked.targets);
      await audit(tx, actor.id, 'alan_kurali_olusturuldu', ruleText(checked));
      return (await ruleView(tx, row.id)) as AlanKurali;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ruleExists();
    throw err;
  }
}

/** PUT /api/alan-kurallari/:id: the whole rule is replaced. */
export async function replaceRule(db: Db, actor: Actor, id: number, input: RuleInput): Promise<AlanKurali> {
  try {
    return await transaction(db, async (tx) => {
      await lockFields(tx);
      const exists = await queryOne(tx, 'SELECT 1 AS x FROM dbo.alan_kurallari WHERE id = @id', { id: p.int(id) });
      if (exists === null) throw notFound('Kural bulunamadı.');
      const checked = await checkRule(tx, input, id);
      await execute(tx, 'UPDATE dbo.alan_kurallari SET kosul_alan_id = @a, kosul_deger_id = @d WHERE id = @id', {
        id: p.int(id),
        a: p.int(checked.condition.id),
        d: p.int(input.kosulDegerId),
      });
      await writeTargets(tx, id, checked.targets);
      await audit(tx, actor.id, 'alan_kurali_guncellendi', ruleText(checked));
      return (await ruleView(tx, id)) as AlanKurali;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw ruleExists();
    throw err;
  }
}

/** DELETE /api/alan-kurallari/:id. */
export async function deleteRule(db: Db, actor: Actor, id: number): Promise<void> {
  await transaction(db, async (tx) => {
    await lockFields(tx);
    const rule = await ruleView(tx, id);
    if (rule === null) throw notFound('Kural bulunamadı.');
    await execute(tx, 'DELETE FROM dbo.alan_kurallari WHERE id = @id', { id: p.int(id) });
    await audit(tx, actor.id, 'alan_kurali_silindi', `${rule.kosulAlan} = ${rule.kosulDeger.gosterim} → ${rule.hedefler.join(', ')}`);
  });
}
