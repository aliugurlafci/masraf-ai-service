import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Sheet } from '@/components/ui/Sheet';
import { Text } from '@/components/ui/Text';
import { formatDate, monthTitle, parseIsoDate, toIsoDate, todayIso, WEEKDAYS_SHORT } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { minTouch, radius, useTheme } from '@/theme';

export interface CalendarSheetProps {
  readonly visible: boolean;
  readonly value: string;
  readonly onChange: (iso: string) => void;
  readonly onClose: () => void;
  readonly title: string;
  /** Allow days after today (an invoice date may be printed ahead; an expense date may not). */
  readonly allowFuture?: boolean;
}

/** Month grid date picker (Monday first). Future days are disabled unless `allowFuture` is set. */
export function CalendarSheet({ visible, value, onChange, onClose, title, allowFuture = false }: CalendarSheetProps) {
  const { colors } = useTheme();
  const selected = parseIsoDate(value) ?? new Date();
  const [cursor, setCursor] = useState({ year: selected.getFullYear(), month: selected.getMonth() });
  const today = todayIso();
  const now = new Date();
  const atCurrentMonth = !allowFuture && cursor.year === now.getFullYear() && cursor.month === now.getMonth();

  const first = new Date(cursor.year, cursor.month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const move = (delta: number): void => {
    const d = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: d.getFullYear(), month: d.getMonth() });
  };

  const pick = (iso: string): void => {
    haptics.tap();
    onChange(iso);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={`Seçili: ${formatDate(value)}`}>
      <View style={styles.nav}>
        <IconButton icon="chevron-back" onPress={() => move(-1)} accessibilityLabel="Önceki ay" tone="soft" />
        <Text variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite">
          {monthTitle(cursor.year, cursor.month)}
        </Text>
        <IconButton
          icon="chevron-forward"
          onPress={() => {
            if (!atCurrentMonth) move(1);
          }}
          accessibilityLabel="Sonraki ay"
          tone="soft"
          color={atCurrentMonth ? colors.textFaint : undefined}
        />
      </View>
      <View style={styles.week}>
        {WEEKDAYS_SHORT.map((d) => (
          <Text key={d} variant="caption" tone="faint" align="center" style={styles.cell}>
            {d}
          </Text>
        ))}
      </View>
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.week}>
          {week.map((day, di) => {
            if (day === null) return <View key={di} style={styles.cell} />;
            const iso = toIsoDate(new Date(cursor.year, cursor.month, day));
            const isSelected = iso === value;
            const isToday = iso === today;
            const future = !allowFuture && iso > today;
            return (
              <Pressable
                key={di}
                disabled={future}
                onPress={() => pick(iso)}
                accessibilityRole="button"
                accessibilityLabel={formatDate(iso)}
                accessibilityState={{ selected: isSelected, disabled: future }}
                style={styles.cell}
              >
                <View
                  style={[
                    styles.day,
                    isSelected && { backgroundColor: colors.primary },
                    !isSelected && isToday && { borderWidth: 1.5, borderColor: colors.primary },
                  ]}
                >
                  <Text
                    variant="label"
                    color={isSelected ? colors.onPrimary : future ? colors.textFaint : colors.text}
                    style={future ? styles.future : undefined}
                  >
                    {day}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
      <Button title="Bugün" variant="secondary" icon="today-outline" onPress={() => pick(today)} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  week: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: minTouch },
  day: { width: minTouch, height: minTouch, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  future: { opacity: 0.5 },
});
