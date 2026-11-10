import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { AlanTanimi } from '@/api/types';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { useMotion } from '@/hooks/useMotion';
import { inputText, type DraftValue, type ReceiptDraft } from '@/hooks/useReceiptValues';
import { blankValue } from '@/lib/fields';
import { formatDate } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { minTouch, spacing, useTheme } from '@/theme';

import { SelectField } from './SelectField';

/** Contract limits (section 3): metin at most 200, uzun_metin at most 1000 characters. */
const MAX_TEXT = 200;
const MAX_LONG_TEXT = 1000;

export interface ReceiptFieldsProps {
  /** The receipt's name for screen readers (file name or invoice). */
  readonly name: string;
  /** The fields the sender fills for each receipt, in order (lib/fields editableReceiptFields). */
  readonly fields: readonly AlanTanimi[];
  readonly required: ReadonlySet<string>;
  /** Required receipt fields still empty. */
  readonly missing: readonly string[];
  readonly values: ReceiptDraft;
  /** Messages by field key (the server's or a local check's). */
  readonly errors: Readonly<Record<string, string>> | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly disabled: boolean;
  readonly onChange: (anahtar: string, value: DraftValue | null) => void;
  /** Opens the option list of a liste field. */
  readonly onPick: (field: AlanTanimi) => void;
  /** Opens the calendar of a tarih field. */
  readonly onPickDate: (field: AlanTanimi) => void;
}

/**
 * "Fiş bilgileri" under one receipt: a one-line summary (filled count, what is missing) that opens into
 * the receipt's fields. Kept closed on a form with several receipts so twenty of them stay short.
 */
export function ReceiptFields({
  name,
  fields,
  required,
  missing,
  values,
  errors,
  expanded,
  onToggle,
  disabled,
  onChange,
  onPick,
  onPickDate,
}: ReceiptFieldsProps) {
  const { colors } = useTheme();
  const motion = useMotion();
  const turn = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    turn.set(motion.reduced ? (expanded ? 1 : 0) : withTiming(expanded ? 1 : 0, { duration: 200 }));
  }, [expanded, motion.reduced, turn]);
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 180}deg` }] }));

  const filled = fields.filter((f) => values[f.anahtar] !== undefined && !blankValue(values[f.anahtar]?.deger));
  const errorCount = fields.filter((f) => errors?.[f.anahtar] !== undefined).length;
  const names = (keys: readonly string[]): string =>
    keys.map((key) => fields.find((f) => f.anahtar === key)?.ad ?? key).join(', ');
  const status =
    errorCount > 0
      ? { tone: 'danger' as const, icon: 'alert-circle' as const, text: errorCount === 1 ? 'Bir alanı düzeltin' : `${errorCount} alanı düzeltin` }
      : missing.length > 0
        ? { tone: 'warning' as const, icon: 'alert-circle-outline' as const, text: `Eksik: ${names(missing)}` }
        : filled.length > 0
          ? { tone: 'success' as const, icon: 'checkmark-circle-outline' as const, text: `${filled.length} alan dolu` }
          : { tone: 'muted' as const, icon: null, text: required.size > 0 ? 'Doldurulacak alanlar var' : 'İsteğe bağlı' };
  const preview = filled.map((f) => `${f.ad}: ${shown(f, values[f.anahtar])}`).join(' · ');
  const toneColor = { danger: colors.danger, warning: colors.warning, success: colors.success, muted: colors.textMuted }[status.tone];

  return (
    <View style={[styles.wrap, { borderTopColor: colors.border }]}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Fiş bilgileri, ${name}. ${status.text}.${!expanded && preview !== '' ? ` ${preview}.` : ''}`}
        accessibilityHint={expanded ? 'Alanları gizler' : 'Bu fişin alanlarını açar'}
        accessibilityState={{ expanded }}
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        scaleTo={0.98}
        style={styles.head}
      >
        <Ionicons name="pricetags-outline" size={18} color={colors.primary} />
        <View style={styles.flex}>
          <Text variant="label">Fiş bilgileri</Text>
          <View style={styles.status}>
            {status.icon !== null ? <Ionicons name={status.icon} size={14} color={toneColor} /> : null}
            <Text variant="caption" tone={status.tone} numberOfLines={1} style={styles.flex}>
              {status.text}
            </Text>
          </View>
          {!expanded && preview !== '' && status.tone !== 'warning' && status.tone !== 'danger' ? (
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {preview}
            </Text>
          ) : null}
        </View>
        <Animated.View style={chevron}>
          <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
        </Animated.View>
      </PressableScale>
      {expanded ? (
        <Animated.View entering={motion.fadeIn} style={styles.fields}>
          {fields.map((field) => (
            <FieldInput
              key={field.anahtar}
              field={field}
              name={name}
              value={values[field.anahtar]}
              required={required.has(field.anahtar)}
              error={errors?.[field.anahtar]}
              disabled={disabled}
              onChange={(value) => onChange(field.anahtar, value)}
              onPick={() => onPick(field)}
              onPickDate={() => onPickDate(field)}
            />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** A value as the summary shows it. */
function shown(field: AlanTanimi, value: DraftValue | undefined): string {
  if (value === undefined) return '';
  if (field.tur === 'tarih' && typeof value.deger === 'string') return formatDate(value.deger);
  if (field.tur === 'sayi') return inputText(value);
  return value.gosterim;
}

function FieldInput({
  field,
  name,
  value,
  required,
  error,
  disabled,
  onChange,
  onPick,
  onPickDate,
}: {
  readonly field: AlanTanimi;
  readonly name: string;
  readonly value: DraftValue | undefined;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DraftValue | null) => void;
  readonly onPick: () => void;
  readonly onPickDate: () => void;
}) {
  const hint = field.aciklama ?? undefined;
  if (field.tur === 'liste') {
    return (
      <SelectField
        label={field.ad}
        value={value?.gosterim ?? null}
        placeholder={`${field.ad} seçin`}
        required={required}
        error={error}
        hint={hint}
        disabled={disabled}
        onPress={onPick}
        onClear={() => onChange(null)}
        accessibilityHint={`${name} için seçenekleri açar`}
      />
    );
  }
  if (field.tur === 'tarih') {
    const iso = typeof value?.deger === 'string' ? value.deger : null;
    return (
      <SelectField
        label={field.ad}
        value={iso === null || iso === '' ? null : formatDate(iso)}
        placeholder="Tarih seçin"
        icon="calendar-outline"
        required={required}
        error={error}
        hint={hint}
        disabled={disabled}
        onPress={onPickDate}
        onClear={() => onChange(null)}
        accessibilityHint="Takvimi açar"
      />
    );
  }
  const text = inputText(value);
  const setText = (next: string): void => onChange(next === '' ? null : { deger: next, gosterim: next });
  return (
    <TextField
      label={field.ad}
      value={text}
      onChangeText={field.tur === 'sayi' ? (t) => setText(t.replace(/[^0-9.,-]/g, '')) : setText}
      required={required}
      error={error}
      hint={hint}
      editable={!disabled}
      multiline={field.tur === 'uzun_metin'}
      maxLength={field.tur === 'uzun_metin' ? MAX_LONG_TEXT : field.tur === 'metin' ? MAX_TEXT : 40}
      keyboardType={field.tur === 'sayi' ? (Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric') : 'default'}
      placeholder={field.tur === 'sayi' ? '0' : undefined}
      accessibilityLabel={`${name}: ${field.ad}`}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.xs },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: minTouch },
  status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  fields: { gap: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs },
});
