import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type ScrollViewInstance, type TextInputInstance } from 'react-native';

import type { RefObject } from 'react';
import type { FaturaBasligi, FaturaKalemi, OkunanFatura } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { PressableScale } from '@/components/ui/PressableScale';
import { Sheet } from '@/components/ui/Sheet';
import { Text } from '@/components/ui/Text';
import { FieldError, FieldLabel, TextField } from '@/components/ui/TextField';
import { formatDate, parseAmount, todayIso } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import {
  HEADER_FIELDS,
  LINE_FIELDS,
  MAX_LINES,
  MAX_TEXT,
  numberToText,
  type FieldSpec,
  type HeaderKey,
  type LineKey,
} from '@/lib/invoiceEdit';
import { radius, spacing, useTheme } from '@/theme';

import { CalendarSheet } from './CalendarSheet';

/** Where an error sits: `fatura.<field>` in the header or `kalemler.<index>.<field>` on a line. */
export type EditErrors = Readonly<Record<string, string>>;

interface Draft {
  readonly header: Readonly<Record<HeaderKey, string>>;
  readonly lines: readonly (Readonly<Record<LineKey, string>> & { readonly id: number })[];
}

const ISO_CURRENCY = /^[A-Za-z]{3}$/;

function toDraft(value: OkunanFatura, nextId: () => number): Draft {
  const header = {} as Record<HeaderKey, string>;
  for (const f of HEADER_FIELDS) {
    const v = value.fatura[f.key];
    header[f.key] = v === null ? '' : typeof v === 'number' ? numberToText(v) : v;
  }
  return { header, lines: value.kalemler.map((line) => lineToDraft(line, nextId())) };
}

function lineToDraft(line: FaturaKalemi, id: number): Draft['lines'][number] {
  const out = { id } as { id: number } & Record<LineKey, string>;
  for (const f of LINE_FIELDS) {
    const v = line[f.key];
    out[f.key] = v === null ? '' : typeof v === 'number' ? numberToText(v) : v;
  }
  return out;
}

/** Text to the schema's value: empty is null, amounts are parsed. Returns an error message when it does not fit. */
function parseField(spec: FieldSpec<string>, text: string): { value: string | number | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  if (spec.kind === 'amount') {
    const n = parseAmount(trimmed);
    return n === null ? { error: 'Geçerli bir sayı girin.' } : { value: n };
  }
  if (spec.kind === 'currency') {
    return ISO_CURRENCY.test(trimmed) ? { value: trimmed.toUpperCase() } : { error: 'Üç harfli para birimi kodu girin (TRY, USD, EUR).' };
  }
  return { value: trimmed };
}

/** Builds the invoice from the draft, or the local errors that stop it. */
function toValue(draft: Draft): { value: OkunanFatura } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const fatura = {} as Record<HeaderKey, string | number | null>;
  for (const f of HEADER_FIELDS) {
    const r = parseField(f, draft.header[f.key]);
    if ('error' in r) errors[`fatura.${f.key}`] = r.error;
    else fatura[f.key] = r.value;
  }
  const kalemler = draft.lines.map((line, i) => {
    const out = {} as Record<LineKey, string | number | null>;
    for (const f of LINE_FIELDS) {
      const r = parseField(f, line[f.key]);
      if ('error' in r) errors[`kalemler.${i}.${f.key}`] = r.error;
      else out[f.key] = r.value;
    }
    return out as unknown as FaturaKalemi;
  });
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { fatura: fatura as unknown as FaturaBasligi, kalemler } };
}

export interface InvoiceEditSheetProps {
  readonly visible: boolean;
  readonly title: string;
  /** What the invoice shows now (the correction, or the read result). */
  readonly value: OkunanFatura | null;
  /** True when the invoice has a correction that can be dropped. */
  readonly canRevert: boolean;
  /** Server errors for this invoice. */
  readonly serverErrors: EditErrors;
  /** Header fields required for sending this receipt (lib/fields; other keys are ignored). */
  readonly required: readonly string[];
  /** Help text by header field (the field definitions' `aciklama`). */
  readonly help?: Readonly<Record<string, string>>;
  readonly onSave: (value: OkunanFatura) => void;
  readonly onRevert: () => void;
  readonly onClose: () => void;
}

const EMPTY: OkunanFatura = {
  fatura: {
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
  },
  kalemler: [],
};

/** "Fatura bilgileri": the 10 header fields and the lines of one invoice, editable. */
export function InvoiceEditSheet({ visible, title, value, canRevert, serverErrors, required, help = NO_HELP, onSave, onRevert, onClose }: InvoiceEditSheetProps) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  return (
    <Sheet visible={visible} onClose={onClose} title="Fatura bilgileri" subtitle={title} scrollRef={scrollRef}>
      {/* Mounted only while the sheet is open, so every opening starts from the current value. */}
      <EditBody
        scrollRef={scrollRef}
        value={value ?? EMPTY}
        canRevert={canRevert}
        serverErrors={serverErrors}
        required={required}
        help={help}
        onSave={onSave}
        onRevert={onRevert}
      />
    </Sheet>
  );
}

const NO_HELP: Readonly<Record<string, string>> = {};

function EditBody({
  scrollRef,
  value,
  canRevert,
  serverErrors,
  required,
  help,
  onSave,
  onRevert,
}: {
  readonly scrollRef: RefObject<ScrollViewInstance | null>;
  readonly value: OkunanFatura;
  readonly canRevert: boolean;
  readonly serverErrors: EditErrors;
  readonly required: readonly string[];
  readonly help: Readonly<Record<string, string>>;
  readonly onSave: (value: OkunanFatura) => void;
  readonly onRevert: () => void;
}) {
  const { colors } = useTheme();
  const counter = useRef(0);
  const nextId = (): number => (counter.current += 1);
  const [draft, setDraft] = useState<Draft>(() => toDraft(value, nextId));
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const [serverShown, setServerShown] = useState<EditErrors>(serverErrors);
  const [calendar, setCalendar] = useState(false);
  // The first empty required field is brought into view (and focused, unless it is the date) once.
  const isRequired = (key: HeaderKey): boolean => required.includes(key);
  const target = useRef(HEADER_FIELDS.find((f) => isRequired(f.key) && value.fatura[f.key] === null)).current;
  const targetInput = useRef<TextInputInstance>(null);
  const reveal = (y: number): void => {
    scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.lg), animated: false });
    // After the sheet's entrance, so the keyboard does not fight the animation.
    if (target?.kind !== 'date') setTimeout(() => targetInput.current?.focus(), 350);
  };

  const errorOf = (path: string): string | undefined => localErrors[path] ?? serverShown[path];
  const clear = (path: string): void => {
    setLocalErrors((e) => (path in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== path)) : e));
    setServerShown((e) => (path in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== path)) : e));
  };

  const setHeader = (key: HeaderKey, text: string): void => {
    setDraft((d) => ({ ...d, header: { ...d.header, [key]: text } }));
    clear(`fatura.${key}`);
  };
  const setLine = (index: number, key: LineKey, text: string): void => {
    setDraft((d) => ({ ...d, lines: d.lines.map((l, i) => (i === index ? { ...l, [key]: text } : l)) }));
    clear(`kalemler.${index}.${key}`);
  };
  const addLine = (): void => {
    if (draft.lines.length >= MAX_LINES) return;
    haptics.tap();
    setDraft((d) => ({ ...d, lines: [...d.lines, lineToDraft({ aciklama: null, miktar: null, birim: null, birimFiyat: null, kdvOrani: null, tutar: null }, nextId())] }));
  };
  const removeLine = (index: number): void => {
    haptics.tap();
    setDraft((d) => ({ ...d, lines: d.lines.filter((_, i) => i !== index) }));
    // Errors are tied to line positions; they no longer match after a removal.
    setLocalErrors({});
    setServerShown((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('kalemler.'))));
  };

  const save = (): void => {
    const result = toValue(draft);
    if ('errors' in result) {
      haptics.error();
      setLocalErrors(result.errors);
      return;
    }
    onSave(result.value);
  };

  const dateText = draft.header.faturaTarihi;

  return (
    <>
      {HEADER_FIELDS.map((f) => {
        const path = `fatura.${f.key}`;
        const empty = draft.header[f.key].trim() === '';
        // A required field left empty is red: sending needs it. A draft can still be saved.
        const mandatory = isRequired(f.key);
        const error = errorOf(path) ?? (mandatory && empty ? 'Gönderim için bu alan gerekli.' : undefined);
        const hint = help[f.key];
        const place = f.key === target?.key ? { onLayout: (e: LayoutChangeEvent) => reveal(e.nativeEvent.layout.y) } : {};
        if (f.kind === 'date') {
          return (
            <View key={f.key} style={styles.field} {...place}>
              <FieldLabel label={f.label} required={mandatory} />
              <View style={styles.dateRow}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`${f.label}${mandatory ? ', zorunlu' : ''}: ${empty ? 'boş' : formatDate(dateText)}`}
                  accessibilityHint="Takvimi açar"
                  onPress={() => setCalendar(true)}
                  style={[styles.dateField, { backgroundColor: colors.surface, borderColor: error !== undefined ? colors.danger : colors.border }]}
                >
                  <Ionicons name="calendar-outline" size={20} color={colors.primary} />
                  <Text variant="bodyStrong" tone={empty ? 'faint' : 'default'} style={styles.flex}>
                    {empty ? 'Tarih seçin' : formatDate(dateText)}
                  </Text>
                </PressableScale>
                {!empty ? (
                  <IconButton icon="close" tone="soft" accessibilityLabel="Tarihi temizle" onPress={() => setHeader('faturaTarihi', '')} />
                ) : null}
              </View>
              {error !== undefined ? (
                <FieldError message={error} />
              ) : hint !== undefined ? (
                <Text variant="small" tone="faint" style={styles.label}>
                  {hint}
                </Text>
              ) : null}
            </View>
          );
        }
        return (
          <View key={f.key} {...place}>
          <TextField
            ref={f.key === target?.key ? targetInput : undefined}
            label={f.label}
            required={mandatory}
            hint={hint}
            value={draft.header[f.key]}
            onChangeText={(t) => setHeader(f.key, f.kind === 'amount' ? t.replace(/[^0-9.,]/g, '') : t)}
            keyboardType={f.kind === 'amount' ? 'decimal-pad' : 'default'}
            autoCapitalize={f.kind === 'currency' ? 'characters' : 'sentences'}
            maxLength={f.kind === 'currency' ? 3 : MAX_TEXT}
            placeholder={f.kind === 'amount' ? '0,00' : undefined}
            error={error}
          />
          </View>
        );
      })}

      <View style={styles.linesHead}>
        <Text variant="heading" accessibilityRole="header" style={styles.flex}>
          Kalemler
        </Text>
        <Text variant="caption" tone="muted">
          {draft.lines.length} kalem
        </Text>
      </View>
      {draft.lines.length === 0 ? (
        <Text variant="small" tone="muted">
          Bu faturada kalem yok.
        </Text>
      ) : null}
      {draft.lines.map((line, index) => (
        <Card key={line.id} tone="alt" style={styles.line}>
          <View style={styles.lineHead}>
            <Text variant="bodyStrong" style={styles.flex}>
              {index + 1}. kalem
            </Text>
            <IconButton
              icon="trash-outline"
              tone="soft"
              color={colors.danger}
              accessibilityLabel={`${index + 1}. kalemi sil`}
              onPress={() => removeLine(index)}
            />
          </View>
          {LINE_FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              value={line[f.key]}
              onChangeText={(t) => setLine(index, f.key, f.kind === 'amount' ? t.replace(/[^0-9.,]/g, '') : t)}
              keyboardType={f.kind === 'amount' ? 'decimal-pad' : 'default'}
              maxLength={MAX_TEXT}
              placeholder={f.kind === 'amount' ? '0,00' : undefined}
              error={errorOf(`kalemler.${index}.${f.key}`)}
              accessibilityLabel={`${index + 1}. kalem ${f.label}`}
            />
          ))}
        </Card>
      ))}
      {draft.lines.length < MAX_LINES ? <Button title="Kalem ekle" icon="add" variant="secondary" onPress={addLine} /> : null}

      <Button title="Kaydet" icon="checkmark" onPress={save} />
      {canRevert ? (
        <Button
          title="Okunan değere dön"
          icon="arrow-undo-outline"
          variant="outline"
          accessibilityHint="Düzeltmeyi kaldırır, faturadan okunan bilgiler geçerli olur"
          onPress={onRevert}
        />
      ) : null}

      <CalendarSheet
        key={calendar ? 'open' : 'closed'}
        visible={calendar}
        value={dateText === '' ? todayIso() : dateText}
        title="Fatura tarihi"
        allowFuture
        onChange={(iso) => setHeader('faturaTarihi', iso)}
        onClose={() => setCalendar(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  field: { gap: spacing.xs },
  label: { marginLeft: spacing.xs },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dateField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.md + 2,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  linesHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: spacing.sm },
  line: { gap: spacing.sm },
  lineHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
