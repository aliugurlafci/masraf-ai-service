import type { AlanDegerleri, AlanKurali, AlanTanimi, AlanlarYaniti, FaturaBasligi, FisDegeri } from '@/api/types';

import { fieldLabel } from './invoiceEdit';

/*
 * Which fields are required (contract section 3, "Fiş alanları, masraf merkezi ve zorunluluk kuralları").
 * This mirrors the server's `requiredFields` (src/expenses/field-rules.ts) only to show asterisks and
 * warnings while the user types; the server decides, and its `eksikAlanlar` and 409 answers are what count.
 */

export const CATEGORY_KEY = 'kategori';
export const COST_CENTRE_KEY = 'masrafMerkezi';

/** GET /api/alanlar: active fields only, rules already reduced to active fields. */
export type FieldDefs = AlanlarYaniti;

/** The form-level values the rules look at. */
export interface FormContext {
  readonly kategoriId: number | null;
  readonly masrafMerkeziId: number | null;
}

/** One receipt's values by field key: the option id for a liste field, the value otherwise. */
export type ReceiptValueMap = Readonly<Record<string, FisDegeri | undefined>>;

/** An invoice header with nothing in it: a read invoice whose fields could not be read. */
export const EMPTY_HEADER: FaturaBasligi = {
  faturaNo: null,
  faturaTarihi: null,
  saticiUnvan: null,
  saticiVergiNo: null,
  aliciUnvan: null,
  aliciVergiNo: null,
  paraBirimi: null,
  araToplam: null,
  kdvToplam: null,
  genelToplam: null,
};

const byKeyOf = (defs: FieldDefs): ReadonlyMap<string, AlanTanimi> => new Map(defs.alanlar.map((f) => [f.anahtar, f] as const));

/** The category field cannot be turned off; every other field counts only while active. */
const conditionActive = (rule: AlanKurali, byKey: ReadonlyMap<string, AlanTanimi>): boolean =>
  rule.kosulAlan === CATEGORY_KEY || byKey.get(rule.kosulAlan)?.aktif === true;

/** A rule whose condition is a form field (category or cost centre) applies to the form and to every receipt. */
const formLevelCondition = (rule: AlanKurali, byKey: ReadonlyMap<string, AlanTanimi>): boolean =>
  rule.kosulAlan === CATEGORY_KEY || rule.kosulAlan === COST_CENTRE_KEY || byKey.get(rule.kosulAlan)?.duzey === 'form';

/** Step 1: whether a rule applies to this form and (for a receipt-field condition) this receipt. */
function ruleApplies(rule: AlanKurali, byKey: ReadonlyMap<string, AlanTanimi>, form: FormContext, values: ReceiptValueMap | null): boolean {
  if (!conditionActive(rule, byKey)) return false;
  if (rule.kosulAlan === CATEGORY_KEY) return form.kategoriId === rule.kosulDeger.id;
  if (rule.kosulAlan === COST_CENTRE_KEY) return form.masrafMerkeziId === rule.kosulDeger.id;
  return values !== null && values[rule.kosulAlan] === rule.kosulDeger.id;
}

/** Step 2: the cost centre is required when active and marked required or the target of a form-level rule that applies. */
export function costCentreRequired(defs: FieldDefs, form: FormContext): boolean {
  const byKey = byKeyOf(defs);
  const field = byKey.get(COST_CENTRE_KEY);
  if (field === undefined || !field.aktif) return false;
  if (field.zorunlu) return true;
  return defs.kurallar.some(
    (rule) => formLevelCondition(rule, byKey) && rule.hedefler.includes(COST_CENTRE_KEY) && ruleApplies(rule, byKey, form, null),
  );
}

/** Step 5: invoice header fields first, then the receipt fields; each group by order, then id. */
export function orderReceiptFields(fields: readonly AlanTanimi[]): AlanTanimi[] {
  const rank = (f: AlanTanimi): number => (f.tur === 'fatura' ? 0 : 1);
  return [...fields].sort((a, b) => rank(a) - rank(b) || a.sira - b.sira || a.id - b.id);
}

/** Every active field filled per receipt (invoice header fields too), in step 5's order. */
export function receiptLevelFields(defs: FieldDefs): AlanTanimi[] {
  return orderReceiptFields(defs.alanlar.filter((f) => f.aktif && (f.duzey === 'fis' || f.tur === 'fatura')));
}

/** The fields the sender fills for each receipt (not the read header fields), in order. */
export function editableReceiptFields(defs: FieldDefs): AlanTanimi[] {
  return receiptLevelFields(defs).filter((f) => f.tur !== 'fatura');
}

/** Step 3: the receipt's required fields (header and receipt fields), in step 5's order. */
export function requiredReceiptFields(defs: FieldDefs, form: FormContext, values: ReceiptValueMap): string[] {
  const byKey = byKeyOf(defs);
  const targeted = new Set<string>();
  for (const rule of defs.kurallar) {
    const applies = formLevelCondition(rule, byKey) ? ruleApplies(rule, byKey, form, null) : ruleApplies(rule, byKey, form, values);
    if (applies) for (const key of rule.hedefler) targeted.add(key);
  }
  return receiptLevelFields(defs)
    .filter((f) => f.zorunlu || targeted.has(f.anahtar))
    .map((f) => f.anahtar);
}

const blankHeader = (value: string | number | null | undefined): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/** A receipt field without a value: none, null or blank text. */
export const blankValue = (value: FisDegeri | undefined): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

/**
 * Step 4: required fields that are empty. `header` is the invoice's effective header; null for a file
 * not read yet, whose header fields are not known and so not listed (EMPTY_HEADER for a read invoice
 * whose fields could not be read).
 */
export function missingReceiptFields(defs: FieldDefs, form: FormContext, values: ReceiptValueMap, header: FaturaBasligi | null): string[] {
  const byKey = byKeyOf(defs);
  return requiredReceiptFields(defs, form, values).filter((key) => {
    const field = byKey.get(key);
    if (field === undefined) return false;
    if (field.tur === 'fatura') return header !== null && blankHeader(header[key as keyof FaturaBasligi]);
    return blankValue(values[key]);
  });
}

// --- Names and values for display ---

const FORM_LABELS: Readonly<Record<string, string>> = { [CATEGORY_KEY]: 'Kategori', [COST_CENTRE_KEY]: 'Masraf merkezi' };

/** A field's name: its definition's, else the built-in one (form and header fields), else the key. */
export function fieldName(defs: FieldDefs | undefined, key: string): string {
  return defs?.alanlar.find((f) => f.anahtar === key)?.ad ?? FORM_LABELS[key] ?? fieldLabel(key);
}

/** "Etiket, proje kodu": field names for a sentence, the first kept as written. */
export function fieldNames(defs: FieldDefs | undefined, keys: readonly string[]): string {
  return keys.map((key, i) => (i === 0 ? fieldName(defs, key) : fieldName(defs, key).toLocaleLowerCase('tr-TR'))).join(', ');
}

export interface ValueLine {
  readonly anahtar: string;
  readonly label: string;
  readonly gosterim: string;
}

/** A receipt's stored values as label/value lines, in the fields' order (unknown keys last, as they came). */
export function valueLines(defs: FieldDefs | undefined, alanlar: AlanDegerleri): ValueLine[] {
  const order = defs === undefined ? [] : editableReceiptFields(defs).map((f) => f.anahtar);
  const keys = Object.keys(alanlar).filter((key) => (alanlar[key]?.gosterim ?? '') !== '');
  const rank = (key: string): number => {
    const at = order.indexOf(key);
    return at < 0 ? order.length : at;
  };
  return keys
    .map((key, i) => ({ key, i }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.i - b.i)
    .map(({ key }) => ({ anahtar: key, label: fieldName(defs, key), gosterim: alanlar[key]?.gosterim ?? '' }));
}

/** "Kod – ad" as the contract shows records (U+2013 with spaces); just the code when the name is empty or the same. */
export function displayName(kod: string, ad: string | null): string {
  const name = ad?.trim() ?? '';
  return name === '' || name === kod ? kod : `${kod} – ${name}`;
}
