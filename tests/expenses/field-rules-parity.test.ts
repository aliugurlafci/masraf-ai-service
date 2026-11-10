// The required-field rules exist three times: the server decides (src/expenses/field-rules.ts), the panel
// (public/js/fields.js) and the mobile app (masraf-app/src/lib/fields.ts) repeat them to draw asterisks and
// warnings. This runs every combination of a small set of fields, rules, forms, receipts and invoice
// headers through all three and expects the same answers. The clients get what GET /api/alanlar gives a
// non-administrator: active fields only, rules whose condition field is active, targets narrowed to
// active fields, rules without a target left out.
import { describe, expect, it, vi } from 'vitest';
import {
  formRequiredFields,
  missingReceiptFields,
  receiptRequiredFields,
  type FieldDef,
  type FieldRule,
  type FormContext,
  type ReceiptValues,
} from '../../src/expenses/field-rules.ts';
import type { Invoice } from '../../src/invoice/schema.ts';

// The mobile module takes only `fieldLabel` from here; the real file pulls in React Native.
vi.mock('../../masraf-app/src/lib/invoiceEdit', () => ({ fieldLabel: (key: string) => key }));

// The clients are loaded by a path in a variable, so the type check does not follow them: the panel has no
// types and the mobile app resolves its imports with its own settings. Their shapes here are the contract's.
interface ApiField extends FieldDef {
  readonly sistem: boolean;
  readonly aciklama: string | null;
  readonly secenekSayisi: number | null;
}
interface ApiRule {
  readonly id: number;
  readonly kosulAlan: string;
  readonly kosulDeger: { readonly id: number; readonly gosterim: string; readonly aktif: boolean };
  readonly hedefler: readonly string[];
}
interface Defs {
  readonly alanlar: readonly ApiField[];
  readonly kurallar: readonly ApiRule[];
}
type Header = Invoice['fatura'];
interface Panel {
  formRequired(fields: readonly ApiField[], rules: readonly ApiRule[], form: FormContext): Set<string>;
  formMissing(fields: readonly ApiField[], rules: readonly ApiRule[], form: FormContext): string[];
  receiptRequired(fields: readonly ApiField[], rules: readonly ApiRule[], form: FormContext, values: ReceiptValues): Set<string>;
  receiptMissing(fields: readonly ApiField[], rules: readonly ApiRule[], form: FormContext, opts: { values: ReceiptValues; invoice: Header | null }): string[];
}
interface Mobile {
  costCentreRequired(defs: Defs, form: FormContext): boolean;
  requiredReceiptFields(defs: Defs, form: FormContext, values: ReceiptValues): string[];
  missingReceiptFields(defs: Defs, form: FormContext, values: ReceiptValues, header: Header | null): string[];
}
const PANEL = '../../public/js/fields.js';
const MOBILE = '../../masraf-app/src/lib/fields.ts';
const panel = (await import(PANEL)) as Panel;
const mobile = (await import(MOBILE)) as Mobile;

type Variant = { mmActive: boolean; mmRequired: boolean; noteActive: boolean; paymentActive: boolean; projectRequired: boolean };

function fieldsOf(v: Variant): FieldDef[] {
  const f = (id: number, anahtar: string, duzey: FieldDef['duzey'], tur: FieldDef['tur'], zorunlu: boolean, aktif: boolean, sira: number): FieldDef => ({
    id,
    anahtar,
    ad: anahtar,
    duzey,
    tur,
    zorunlu,
    aktif,
    sira,
  });
  return [
    f(1, 'kategori', 'form', 'kategori', true, true, 1),
    f(2, 'masrafMerkezi', 'form', 'masraf_merkezi', v.mmRequired, v.mmActive, 2),
    f(3, 'faturaNo', 'fis', 'fatura', true, true, 1),
    f(4, 'genelToplam', 'fis', 'fatura', false, true, 2),
    // Same sira as projeKodu: the id decides.
    f(12, 'etiket', 'fis', 'liste', false, true, 10),
    f(11, 'projeKodu', 'fis', 'liste', v.projectRequired, true, 10),
    f(13, 'odemeYontemi', 'fis', 'liste', false, v.paymentActive, 5),
    f(14, 'not', 'fis', 'uzun_metin', false, v.noteActive, 20),
  ];
}

const RULES: FieldRule[] = [
  { id: 1, kosulAlan: 'kategori', kosulDegerId: 5, hedefler: ['masrafMerkezi', 'etiket'] },
  { id: 2, kosulAlan: 'masrafMerkezi', kosulDegerId: 7, hedefler: ['genelToplam', 'projeKodu'] },
  { id: 3, kosulAlan: 'odemeYontemi', kosulDegerId: 33, hedefler: ['not'] },
  { id: 4, kosulAlan: 'etiket', kosulDegerId: 40, hedefler: ['faturaNo', 'odemeYontemi'] },
  { id: 5, kosulAlan: 'etiket', kosulDegerId: 41, hedefler: ['not'] },
];

/** What GET /api/alanlar (without tumu) answers for these definitions. */
function clientView(fields: readonly FieldDef[]): Defs {
  const active = fields.filter((f) => f.aktif);
  const activeKeys = new Set(active.map((f) => f.anahtar));
  return {
    alanlar: active.map((f) => ({ ...f, sistem: f.duzey === 'form' || f.tur === 'fatura', aciklama: null, secenekSayisi: f.tur === 'liste' ? 3 : null })),
    kurallar: RULES.filter((r) => activeKeys.has(r.kosulAlan))
      .map((r) => ({ id: r.id, kosulAlan: r.kosulAlan, kosulDeger: { id: r.kosulDegerId, gosterim: String(r.kosulDegerId), aktif: true }, hedefler: r.hedefler.filter((k) => activeKeys.has(k)) }))
      .filter((r) => r.hedefler.length > 0),
  };
}

const header = (faturaNo: string | null, genelToplam: number | null): Header => ({
  faturaNo,
  faturaTarihi: '2026-11-09',
  saticiUnvan: 'Örnek',
  saticiVergiNo: null,
  aliciUnvan: null,
  aliciVergiNo: null,
  paraBirimi: 'TRY',
  araToplam: null,
  kdvToplam: null,
  genelToplam,
});

const BOOLS = [true, false];
const variants: Variant[] = BOOLS.flatMap((mmActive) =>
  BOOLS.flatMap((mmRequired) =>
    BOOLS.flatMap((noteActive) =>
      BOOLS.flatMap((paymentActive) => BOOLS.map((projectRequired) => ({ mmActive, mmRequired, noteActive, paymentActive, projectRequired }))),
    ),
  ),
);
const forms: FormContext[] = [null, 5, 6].flatMap((kategoriId) => [null, 7, 8].map((masrafMerkeziId) => ({ kategoriId, masrafMerkeziId })));
const receipts: ReceiptValues[] = [null, 40, 41].flatMap((etiket) =>
  [null, 33].flatMap((odemeYontemi) =>
    [null, 50].flatMap((projeKodu) =>
      [null, '  ', 'Araç yıkama'].map((not) => {
        const values: Record<string, number | string> = {};
        if (etiket !== null) values.etiket = etiket;
        if (odemeYontemi !== null) values.odemeYontemi = odemeYontemi;
        if (projeKodu !== null) values.projeKodu = projeKodu;
        if (not !== null) values.not = not;
        return values;
      }),
    ),
  ),
);
const headers: Array<Header | null> = [null, header('F1', 120), header('  ', null)];

describe('required fields: server, panel and mobile agree', () => {
  it('on every combination', () => {
    let cases = 0;
    const mismatches: string[] = [];
    for (const v of variants) {
      const fields = fieldsOf(v);
      const view = clientView(fields);
      for (const form of forms) {
        const serverCostCentre = formRequiredFields(fields, RULES, form).includes('masrafMerkezi');
        const panelCostCentre = panel.formRequired(view.alanlar, view.kurallar, form).has('masrafMerkezi');
        const mobileCostCentre = mobile.costCentreRequired(view, form);
        const serverFormMissing = serverCostCentre && form.masrafMerkeziId === null ? ['masrafMerkezi'] : [];
        const panelFormMissing = panel.formMissing(view.alanlar, view.kurallar, form);
        if (panelCostCentre !== serverCostCentre || mobileCostCentre !== serverCostCentre || JSON.stringify(panelFormMissing) !== JSON.stringify(serverFormMissing)) {
          mismatches.push(`form ${JSON.stringify({ v, form })}: server ${serverCostCentre}, panel ${panelCostCentre}, mobile ${mobileCostCentre}`);
        }
        for (const values of receipts) {
          const required = receiptRequiredFields(fields, RULES, form, values);
          const serverRequired = required.map((f) => f.anahtar);
          const panelRequired = [...panel.receiptRequired(view.alanlar, view.kurallar, form, values)].sort();
          const mobileRequired = mobile.requiredReceiptFields(view, form, values);
          if (JSON.stringify(mobileRequired) !== JSON.stringify(serverRequired) || JSON.stringify(panelRequired) !== JSON.stringify([...serverRequired].sort())) {
            mismatches.push(`required ${JSON.stringify({ v, form, values })}: server ${serverRequired}, panel ${panelRequired}, mobile ${mobileRequired}`);
          }
          for (const h of headers) {
            cases++;
            const server = missingReceiptFields(required, values, h);
            const fromPanel = panel.receiptMissing(view.alanlar, view.kurallar, form, { values, invoice: h });
            const fromMobile = mobile.missingReceiptFields(view, form, values, h);
            if (JSON.stringify(fromPanel) !== JSON.stringify(server) || JSON.stringify(fromMobile) !== JSON.stringify(server)) {
              mismatches.push(`missing ${JSON.stringify({ v, form, values, h: h?.faturaNo ?? null })}: server ${server}, panel ${fromPanel}, mobile ${fromMobile}`);
            }
          }
        }
      }
    }
    expect(cases).toBe(variants.length * forms.length * receipts.length * headers.length);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it('the combinations reach every rule and every way a field becomes required', () => {
    // Guards the table above: without these, agreement could come from nothing ever being required.
    const fields = fieldsOf({ mmActive: true, mmRequired: false, noteActive: true, paymentActive: true, projectRequired: false });
    expect(formRequiredFields(fields, RULES, { kategoriId: 5, masrafMerkeziId: null })).toEqual(['masrafMerkezi']);
    const form = { kategoriId: 5, masrafMerkeziId: 7 };
    const keys = receiptRequiredFields(fields, RULES, form, { etiket: 40, odemeYontemi: 33 }).map((f) => f.anahtar);
    expect(keys).toEqual(['faturaNo', 'genelToplam', 'odemeYontemi', 'projeKodu', 'etiket', 'not']);
    expect(missingReceiptFields(receiptRequiredFields(fields, RULES, form, { etiket: 41, not: '  ' }), { etiket: 41, not: '  ' }, header('  ', null))).toEqual([
      'faturaNo',
      'genelToplam',
      'projeKodu',
      'not',
    ]);
  });
});
