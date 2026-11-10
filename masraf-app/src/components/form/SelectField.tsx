import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import type { IconName } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { FieldError, FieldLabel } from '@/components/ui/TextField';
import { radius, spacing, useTheme } from '@/theme';

export interface SelectFieldProps {
  readonly label: string;
  /** What is chosen, as shown; null when nothing is. */
  readonly value: string | null;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly error?: string;
  /** Help under the field (the field's description); an error replaces it. */
  readonly hint?: string | null;
  /** A short note after the value, e.g. that the stored record is no longer active. */
  readonly note?: string | null;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  /** Shown while something is chosen: empties the field. */
  readonly onClear?: () => void;
  readonly accessibilityHint?: string;
}

/** A field that opens a picker (a list or a calendar) instead of taking typed text. */
export function SelectField({
  label,
  value,
  placeholder = 'Seçin',
  required = false,
  error,
  hint,
  note,
  icon = 'chevron-down',
  disabled = false,
  onPress,
  onClear,
  accessibilityHint = 'Seçenekleri açar',
}: SelectFieldProps) {
  const { colors } = useTheme();
  const hasError = error !== undefined && error !== '';
  const empty = value === null || value === '';
  return (
    <View style={styles.wrap}>
      <FieldLabel label={label} required={required} />
      <View style={[styles.box, { backgroundColor: colors.surface, borderColor: hasError ? colors.danger : colors.border, borderWidth: hasError ? 2 : 1 }]}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${label}${required ? ', zorunlu' : ''}: ${empty ? 'seçilmedi' : value}${note ? `, ${note}` : ''}`}
          accessibilityHint={hasError ? error : accessibilityHint}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          scaleTo={0.98}
          style={styles.press}
        >
          <View style={styles.text}>
            <Text variant="body" tone={empty ? 'faint' : 'default'} numberOfLines={2}>
              {empty ? placeholder : value}
            </Text>
            {note ? (
              <Text variant="caption" tone="warning" numberOfLines={1}>
                {note}
              </Text>
            ) : null}
          </View>
          <Ionicons name={icon} size={icon === 'chevron-down' ? 18 : 20} color={colors.textMuted} />
        </PressableScale>
        {!empty && onClear !== undefined ? (
          <IconButton icon="close" accessibilityLabel={`${label}: seçimi kaldır`} onPress={onClear} disabled={disabled} color={colors.textMuted} />
        ) : null}
      </View>
      {hasError ? (
        <FieldError message={error} />
      ) : hint ? (
        <Text variant="small" tone="faint" style={styles.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs + 2 },
  box: { minHeight: 52, borderRadius: radius.lg, flexDirection: 'row', alignItems: 'center', paddingRight: spacing.xs },
  press: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingLeft: spacing.md + 2, paddingRight: spacing.sm, paddingVertical: spacing.xs },
  text: { flex: 1, gap: 2 },
  hint: { marginLeft: spacing.xs },
});
