// Receipt fields, the cost centre and the required-field rules (docs/onay-sistemi.md, section 3,
// "Fiş alanları, masraf merkezi ve zorunluluk kuralları"). requiredFields in
// src/expenses/field-rules.ts decides; this mirror only draws the asterisks and the warnings.
//
// Input everywhere: `fields` and `rules` as GET /api/alanlar answers (without tumu: only active
// fields, rules already cut to active ones), the form ({ kategoriId, masrafMerkeziId }) and one
// receipt's values ({ anahtar: deger }, an option id for a 'liste' field).

/** Field types (AlanTanimi.tur) a sender fills in on a receipt, with their Turkish names. */
export const ENTRY_TYPES = {
  liste: 'Liste',
  metin: 'Metin',
  uzun_metin: 'Uzun metin',
  sayi: 'Sayı',
  tarih: 'Tarih',
};

export const TYPE_LABEL = {
  ...ENTRY_TYPES,
  kategori: 'Kategori',
  masraf_merkezi: 'Masraf merkezi',
  fatura: 'Fatura bilgisi',
};

/** Text limits by type (docs: fisAlanlari values). */
export const TEXT_MAX = { metin: 200, uzun_metin: 1000 };

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);

/** A header field of the read invoice (faturaNo, genelToplam, …). */
export const isInvoiceField = (f) => f?.tur === 'fatura';
/** Receipt level: the invoice header fields and the fields the sender fills in. */
export const isReceiptLevel = (f) => f?.duzey !== 'form';
/** A field the sender fills in for each receipt (not the read invoice header). */
export const isEntryField = (f) => isReceiptLevel(f) && !isInvoiceField(f);

/** Invoice header fields first (by sira), then the others (by sira, then id). */
export function ordered(fields) {
  return (fields ?? []).slice().sort((a, b) => {
    const ga = isInvoiceField(a) ? 0 : 1;
    const gb = isInvoiceField(b) ? 0 : 1;
    return ga - gb || (a.sira ?? 0) - (b.sira ?? 0) || (a.id ?? 0) - (b.id ?? 0);
  });
}

/** The active fields a sender fills in on each receipt, in order. */
export const entryFields = (fields) => ordered(fields).filter((f) => f.aktif !== false && isEntryField(f));

const byKey = (fields) => new Map((fields ?? []).map((f) => [f.anahtar, f]));

/** A rule's condition is on the form (kategori, masrafMerkezi) rather than on one receipt. */
const formCondition = (rule, index) => index.get(rule.kosulAlan)?.duzey === 'form';

/** Rule step 1: the condition field is active and has the rule's value (form's or this receipt's). */
function applies(rule, index, form, values) {
  const cond = index.get(rule.kosulAlan);
  if (!cond || cond.aktif === false) return false;
  const want = rule.kosulDeger?.id;
  if (rule.kosulAlan === 'kategori') return sameId(form?.kategoriId, want);
  if (rule.kosulAlan === 'masrafMerkezi') return sameId(form?.masrafMerkeziId, want);
  return sameId(values?.[rule.kosulAlan], want);
}

/**
 * Form level (step 2): 'kategori' always; 'masrafMerkezi' when it is active and either marked
 * required or the target of an applying rule whose condition is on the form.
 */
export function formRequired(fields, rules, form) {
  const index = byKey(fields);
  const out = new Set(['kategori']);
  const mm = index.get('masrafMerkezi');
  if (mm && mm.aktif !== false) {
    const ruled = (rules ?? []).some((r) => formCondition(r, index) && (r.hedefler ?? []).includes('masrafMerkezi') && applies(r, index, form, null));
    if (mm.zorunlu || ruled) out.add('masrafMerkezi');
  }
  return out;
}

/** Receipt level (step 3): the keys of the receipt fields required on this receipt. */
export function receiptRequired(fields, rules, form, values) {
  const index = byKey(fields);
  const targeted = new Set();
  for (const r of rules ?? []) {
    if (!applies(r, index, form, values)) continue;
    for (const k of r.hedefler ?? []) targeted.add(k);
  }
  return new Set(
    (fields ?? []).filter((f) => isReceiptLevel(f) && f.aktif !== false && (f.zorunlu || targeted.has(f.anahtar))).map((f) => f.anahtar),
  );
}

/**
 * Step 4 and 5: the required receipt fields that are empty, in order. `invoice` is the invoice's
 * valid header data (a correction wins), or null for a file still being read: its header fields are
 * not known yet and are left out.
 */
export function receiptMissing(fields, rules, form, { values = {}, invoice = null } = {}) {
  const req = receiptRequired(fields, rules, form, values);
  return ordered(fields)
    .filter((f) => req.has(f.anahtar))
    .filter((f) => (isInvoiceField(f) ? invoice !== null && invoice !== undefined && blank(invoice[f.anahtar]) : blank(values?.[f.anahtar])))
    .map((f) => f.anahtar);
}

/** The form-level fields that are required and empty (only masrafMerkezi can be). */
export function formMissing(fields, rules, form) {
  const req = formRequired(fields, rules, form);
  return req.has('masrafMerkezi') && (form?.masrafMerkeziId === null || form?.masrafMerkeziId === undefined) ? ['masrafMerkezi'] : [];
}

/** { anahtar: deger } from a receipt's `alanlar` ({ anahtar: { deger, gosterim } }). */
export function valuesOf(alanlar) {
  const out = {};
  for (const [k, v] of Object.entries(alanlar ?? {})) if (v && !blank(v.deger)) out[k] = v.deger;
  return out;
}

/** { anahtar: gosterim } from a receipt's `alanlar`. */
export function shownOf(alanlar) {
  const out = {};
  for (const [k, v] of Object.entries(alanlar ?? {})) if (v && !blank(v.gosterim)) out[k] = String(v.gosterim);
  return out;
}

/** True when a value counts as entered (0 does). */
export const hasValue = (v) => !blank(v);

/** A key's label from the field list, else the fallback (or the key itself). */
export function labelFrom(fields, key, fallback = null) {
  return (fields ?? []).find((f) => f.anahtar === key)?.ad ?? fallback ?? key;
}
