// Receipt fields, the cost centre and the rules that make fields required (docs/onay-sistemi.md,
// section 3, "Fiş alanları, masraf merkezi ve zorunluluk kuralları"). Pure functions; no database.
//
// The server decides what is required. The panel (public/js/fields.js) and the mobile app
// (masraf-app/src/lib/fields.ts) repeat requiredFields exactly, only to mark fields and warn early.
//
// The algorithm (requiredFields):
//  1. A rule applies when its condition field is active and the condition holds: for 'kategori' the
//     form's category is the rule's value, for 'masrafMerkezi' the form's cost centre is, and for a
//     receipt 'liste' field the receipt's value (an option id) is.
//  2. Form level: 'masrafMerkezi' is required when it is active and either marked required or the target
//     of an applying rule whose condition is a form field. 'kategori' is never listed: saving needs it.
//  3. Receipt level, for each invoice and each waiting file on its own: a receipt field is required when
//     it is active and either marked required or the target of a rule that applies to this receipt. Rules
//     with a form-level condition apply to every receipt of the form.
//  4. A required field is missing when it is empty: a 'fatura' field when the invoice's effective header
//     value is null or blank text, any other field when the receipt has no value for it. A waiting file has
//     not been read, so its 'fatura' fields are never listed.
//  5. Order: 'fatura' fields first (by sira), then the other receipt fields (by sira, then id).
import { InvoiceHeaderSchema, type Invoice } from '../invoice/schema.ts';

export const FIELD_TYPES = ['kategori', 'masraf_merkezi', 'fatura', 'liste', 'metin', 'uzun_metin', 'sayi', 'tarih'] as const;
export type AlanTuru = (typeof FIELD_TYPES)[number];

/** The types an administrator can give a new receipt field. */
export const RECEIPT_TYPES = ['liste', 'metin', 'uzun_metin', 'sayi', 'tarih'] as const;
export type FisAlanTuru = (typeof RECEIPT_TYPES)[number];

export type Duzey = 'form' | 'fis';

export const CATEGORY_KEY = 'kategori';
export const COST_CENTRE_KEY = 'masrafMerkezi';

/** Receipt fields (inactive included, invoice header fields excluded) an administrator may define. */
export const MAX_RECEIPT_FIELDS = 40;
export const MAX_KEY_LENGTH = 40;
/** Text limits of the text types, after trimming. */
/** Largest SQL Server int: option ids above it can't exist and would fail as a parameter. */
const MAX_INT = 2_147_483_647;
export const TEXT_LIMITS: Readonly<Record<'metin' | 'uzun_metin', number>> = { metin: 200, uzun_metin: 1000 };

export interface FieldDef {
  readonly id: number;
  readonly anahtar: string;
  readonly ad: string;
  readonly duzey: Duzey;
  readonly tur: AlanTuru;
  readonly zorunlu: boolean;
  readonly aktif: boolean;
  readonly sira: number;
}

/** "When the condition field has this value, these fields are required." */
export interface FieldRule {
  readonly id: number;
  /** Key of the condition field: 'kategori', 'masrafMerkezi' or a 'liste' receipt field. */
  readonly kosulAlan: string;
  /** A category, cost centre or option id, by the condition field. */
  readonly kosulDegerId: number;
  /** Keys of the fields the rule makes required. */
  readonly hedefler: readonly string[];
}

export interface FormContext {
  readonly kategoriId: number | null;
  readonly masrafMerkeziId: number | null;
}

/**
 * A receipt's values by field key: the option id for a 'liste' field, the stored text otherwise
 * ('sayi' and 'tarih' as text too). A key without a value is left out (or null).
 */
export type ReceiptValues = Readonly<Record<string, number | string | null | undefined>>;

export type HeaderKey = keyof Invoice['fatura'];
const HEADER_KEYS: ReadonlySet<string> = new Set(Object.keys(InvoiceHeaderSchema.shape));

const isFormKey = (key: string): boolean => key === CATEGORY_KEY || key === COST_CENTRE_KEY;

/** A receipt field the sender fills in (not an invoice header field). */
export const isEntryField = (f: Pick<FieldDef, 'duzey' | 'tur'>): boolean => f.duzey === 'fis' && f.tur !== 'fatura';

const own = (values: ReceiptValues, key: string): number | string | null => (Object.hasOwn(values, key) ? (values[key] ?? null) : null);

/** Whether a stored or entered value counts as filled. */
export function hasValue(v: number | string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return typeof v !== 'string' || v.trim() !== '';
}

const byKeyOf = (fields: readonly FieldDef[]): ReadonlyMap<string, FieldDef> => new Map(fields.map((f) => [f.anahtar, f]));

/** Step 1: whether `rule` applies, given the form and (for a receipt-field condition) the receipt's values. */
export function ruleApplies(rule: FieldRule, byKey: ReadonlyMap<string, FieldDef>, form: FormContext, values: ReceiptValues = {}): boolean {
  const condition = byKey.get(rule.kosulAlan);
  if (condition === undefined || !condition.aktif) return false;
  if (rule.kosulAlan === CATEGORY_KEY) return form.kategoriId === rule.kosulDegerId;
  if (rule.kosulAlan === COST_CENTRE_KEY) return form.masrafMerkeziId === rule.kosulDegerId;
  if (condition.duzey !== 'fis' || condition.tur !== 'liste') return false;
  return own(values, rule.kosulAlan) === rule.kosulDegerId;
}

/** Step 5: 'fatura' fields first by sira, then the other receipt fields by sira, then id. */
export function receiptOrder(a: FieldDef, b: FieldDef): number {
  const group = (f: FieldDef): number => (f.tur === 'fatura' ? 0 : 1);
  return group(a) - group(b) || a.sira - b.sira || a.id - b.id;
}

/** Step 2: the form-level required fields; only 'masrafMerkezi' can be one. */
export function formRequiredFields(fields: readonly FieldDef[], rules: readonly FieldRule[], form: FormContext): string[] {
  const byKey = byKeyOf(fields);
  const costCentre = byKey.get(COST_CENTRE_KEY);
  if (costCentre === undefined || !costCentre.aktif) return [];
  const byRule = rules.some((r) => isFormKey(r.kosulAlan) && r.hedefler.includes(COST_CENTRE_KEY) && ruleApplies(r, byKey, form));
  return costCentre.zorunlu || byRule ? [COST_CENTRE_KEY] : [];
}

/** Step 3: the receipt's required fields (invoice header fields included), in step 5's order. */
export function receiptRequiredFields(fields: readonly FieldDef[], rules: readonly FieldRule[], form: FormContext, values: ReceiptValues = {}): FieldDef[] {
  const byKey = byKeyOf(fields);
  const targeted = new Set<string>();
  for (const rule of rules) {
    if (ruleApplies(rule, byKey, form, values)) for (const key of rule.hedefler) targeted.add(key);
  }
  return fields.filter((f) => f.duzey === 'fis' && f.aktif && (f.zorunlu || targeted.has(f.anahtar))).sort(receiptOrder);
}

/** Steps 2 and 3 together: the keys required on the form and on one receipt. */
export function requiredFields(
  fields: readonly FieldDef[],
  rules: readonly FieldRule[],
  form: FormContext,
  values: ReceiptValues = {},
): { form: string[]; fis: string[] } {
  return { form: formRequiredFields(fields, rules, form), fis: receiptRequiredFields(fields, rules, form, values).map((f) => f.anahtar) };
}

const blankHeader = (v: string | number | null): boolean => v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Step 4: the required fields (from receiptRequiredFields) that are empty on this receipt. `header` is the
 * invoice's effective header; null for a file not read yet, whose 'fatura' fields are then left out.
 */
export function missingReceiptFields(required: readonly FieldDef[], values: ReceiptValues, header: Invoice['fatura'] | null): string[] {
  return required
    .filter((f) => {
      if (f.tur !== 'fatura') return !hasValue(own(values, f.anahtar));
      if (header === null || !HEADER_KEYS.has(f.anahtar)) return false;
      return blankHeader(header[f.anahtar as HeaderKey]);
    })
    .map((f) => f.anahtar);
}

/** The header keys among `required`, for the invoice check (src/invoice/effective.ts, missingFields). */
export const headerKeys = (required: readonly FieldDef[]): HeaderKey[] =>
  required.filter((f) => f.tur === 'fatura' && HEADER_KEYS.has(f.anahtar)).map((f) => f.anahtar as HeaderKey);

// ---------------------------------------------------------------------------------------------------
// Administration

/** Properties an administrator may change on a field of this kind (section 3, the group table). */
export type FieldProp = 'ad' | 'zorunlu' | 'aktif' | 'sira' | 'aciklama';

export function editableProps(f: Pick<FieldDef, 'tur'>): readonly FieldProp[] {
  switch (f.tur) {
    case 'kategori':
      return ['aciklama'];
    case 'masraf_merkezi':
      return ['zorunlu', 'aktif', 'aciklama'];
    case 'fatura':
      return ['zorunlu', 'aciklama'];
    default:
      return ['ad', 'zorunlu', 'aktif', 'sira', 'aciklama'];
  }
}

const TO_ASCII: Readonly<Record<string, string>> = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The key a field name gives: Turkish letters to ASCII (other accents dropped), words joined in
 * camelCase ("Araç Plakası" → "aracPlakasi"), "alan" in front when it would not start with a letter, at
 * most 40 characters.
 */
export function keyOfName(name: string): string {
  const ascii = name
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TO_ASCII[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const words = ascii.split(/[^A-Za-z0-9]+/).filter((w) => w !== '');
  let key = words.map((w, i) => (i === 0 ? w.toLowerCase() : capitalize(w.toLowerCase()))).join('');
  if (!/^[a-z]/.test(key)) key = `alan${capitalize(key)}`;
  return key.slice(0, MAX_KEY_LENGTH);
}

/**
 * A new field's key: keyOfName, with 2, 3, … at its end while the key is taken. Names of Object's own
 * properties ("constructor", "toString", …) count as taken, so a key never collides with them in the
 * plain objects clients build from the API.
 */
export function newFieldKey(name: string, taken: ReadonlySet<string>): string {
  const base = keyOfName(name);
  const free = (k: string): boolean => !taken.has(k) && !(k in Object.prototype);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const key = `${base.slice(0, MAX_KEY_LENGTH - suffix.length)}${suffix}`;
    if (free(key)) return key;
  }
}

// ---------------------------------------------------------------------------------------------------
// Values

/** A value as stored: an option of a 'liste' field, or text for the others. */
export type StoredValue = { readonly secenekId: number; readonly metin: null } | { readonly secenekId: null; readonly metin: string };

/** A request value checked against its field: the value to store, null to delete it, or the error. */
export type ParsedValue = { readonly ok: true; readonly value: StoredValue | null } | { readonly ok: false; readonly mesaj: string };

const realDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * Checks one value of `fisAlanlari` (section 6) by the field's type. null and blank text delete the value;
 * text is trimmed. Whether an option belongs to the field and is active is checked by the caller.
 */
export function parseReceiptValue(field: Pick<FieldDef, 'ad' | 'tur'>, raw: unknown): ParsedValue {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, value: null };
  switch (field.tur) {
    case 'liste':
      return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= MAX_INT
        ? { ok: true, value: { secenekId: raw, metin: null } }
        : { ok: false, mesaj: `${field.ad} için listeden bir seçenek seçin.` };
    case 'metin':
    case 'uzun_metin': {
      if (typeof raw !== 'string') return { ok: false, mesaj: `${field.ad} metin olmalıdır.` };
      const text = raw.trim();
      const max = TEXT_LIMITS[field.tur];
      return text.length > max ? { ok: false, mesaj: `${field.ad} en fazla ${max} karakter olabilir.` } : { ok: true, value: { secenekId: null, metin: text } };
    }
    case 'sayi':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { ok: true, value: { secenekId: null, metin: String(raw) } }
        : { ok: false, mesaj: `${field.ad} sayı olmalıdır.` };
    case 'tarih':
      return typeof raw === 'string' && realDate(raw.trim())
        ? { ok: true, value: { secenekId: null, metin: raw.trim() } }
        : { ok: false, mesaj: `${field.ad} YYYY-AA-GG biçiminde geçerli bir tarih olmalıdır.` };
    default:
      return { ok: false, mesaj: 'Bu alan fişte kullanılmıyor.' };
  }
}

/** A receipt field value as the API shows it (AlanDegeri). */
export interface AlanDegeri {
  readonly deger: number | string;
  readonly gosterim: string;
}

/**
 * The API view of a stored value. `optionText` is the option's gösterim for a 'liste' field. A 'sayi'
 * value goes back as a number.
 */
export function valueView(tur: AlanTuru, stored: StoredValue, optionText: string | null): AlanDegeri {
  if (stored.secenekId !== null) return { deger: stored.secenekId, gosterim: optionText ?? String(stored.secenekId) };
  if (tur === 'sayi') {
    const n = Number(stored.metin);
    return Number.isFinite(n) ? { deger: n, gosterim: String(n) } : { deger: stored.metin, gosterim: stored.metin };
  }
  return { deger: stored.metin, gosterim: stored.metin };
}

/** The value rules and missing checks read: the option id for an option, the text otherwise. */
export const ruleValue = (stored: StoredValue): number | string => stored.secenekId ?? stored.metin;

/** Whether two stored values are the same. */
export function sameValue(a: StoredValue | null | undefined, b: StoredValue | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return a.secenekId === b.secenekId && a.metin === b.metin;
}
