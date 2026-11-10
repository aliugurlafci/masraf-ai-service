import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { errorMessage } from '@/api/client';
import { OPTION_PAGE_SIZE, useSecenekler } from '@/api/queries';
import { Button } from '@/components/ui/Button';
import { PressableScale } from '@/components/ui/PressableScale';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { Banner } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMotion } from '@/hooks/useMotion';
import { haptics } from '@/lib/haptics';
import { minTouch, radius, spacing, useTheme } from '@/theme';

/** One choice in the list. `note` is shown under it (e.g. that a stored record is no longer active). */
export interface PickOption {
  readonly id: number;
  readonly gosterim: string;
  readonly note?: string;
}

/**
 * Where the options come from: a liste field's options, searched on the server page by page, or a short
 * list the app already holds (the user's cost centres), filtered on the device.
 */
export type OptionSource =
  | { readonly kind: 'remote'; readonly anahtar: string; readonly count: number | null }
  | { readonly kind: 'local'; readonly options: readonly PickOption[] };

export interface OptionPickerSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly subtitle?: string;
  readonly source: OptionSource;
  readonly selectedId: number | null;
  readonly onSelect: (option: PickOption) => void;
  readonly onClose: () => void;
}

const SEARCH_DELAY_MS = 300;
/** A local list this long gets a search box; a remote one always has it. */
const LOCAL_SEARCH_FROM = 8;
/** A list this long opens with the keyboard up: searching is quicker than scrolling. */
const FOCUS_SEARCH_FROM = 30;

const lower = (text: string): string => text.toLocaleLowerCase('tr-TR');

/** A bottom sheet to pick one option: search box, list, "load more". Picking closes it. */
export function OptionPickerSheet({ visible, title, subtitle, source, selectedId, onSelect, onClose }: OptionPickerSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      {/* Mounted only while open, so every opening starts with an empty search. */}
      {source.kind === 'remote' ? (
        <RemoteOptions anahtar={source.anahtar} count={source.count} selectedId={selectedId} onSelect={onSelect} onClose={onClose} />
      ) : (
        <LocalOptions options={source.options} selectedId={selectedId} onSelect={onSelect} onClose={onClose} />
      )}
    </Sheet>
  );
}

interface BodyProps {
  readonly selectedId: number | null;
  readonly onSelect: (option: PickOption) => void;
  readonly onClose: () => void;
}

function RemoteOptions({ anahtar, count, selectedId, onSelect, onClose }: BodyProps & { readonly anahtar: string; readonly count: number | null }) {
  const [q, setQ] = useState('');
  const search = useDebouncedValue(q, SEARCH_DELAY_MS);
  const list = useSecenekler(anahtar, search);
  const options = list.data?.pages.flatMap((p) => p.kayitlar) ?? [];
  const total = list.data?.pages[list.data.pages.length - 1]?.toplam ?? null;
  // The previous results stay on screen while a new search runs; a spinner in the box says it is busy.
  const searching = list.isFetching && !list.isFetchingNextPage && (q !== search || list.isPlaceholderData);

  return (
    <>
      <SearchBox value={q} onChange={setQ} busy={searching} autoFocus={(count ?? 0) >= FOCUS_SEARCH_FROM} />
      {list.isPending ? (
        <OptionSkeleton />
      ) : list.isError && options.length === 0 ? (
        <View style={styles.state}>
          <Banner tone="danger" message={errorMessage(list.error)} />
          <Button title="Tekrar dene" icon="refresh" variant="secondary" size="sm" onPress={() => void list.refetch()} />
        </View>
      ) : (
        <>
          <OptionRows options={options} selectedId={selectedId} onSelect={onSelect} onClose={onClose} empty={search.trim() === '' ? 'Bu alanın seçeneği yok.' : 'Eşleşen seçenek yok.'} />
          {total !== null && options.length > 0 && total > options.length ? (
            <Text variant="caption" tone="muted" align="center">
              {total} seçenekten {options.length} tanesi gösteriliyor
            </Text>
          ) : null}
          {list.hasNextPage ? (
            <Button
              title="Daha fazla göster"
              icon="chevron-down"
              variant="secondary"
              size="sm"
              loading={list.isFetchingNextPage}
              accessibilityHint={`Sonraki ${OPTION_PAGE_SIZE} seçeneği yükler`}
              onPress={() => void list.fetchNextPage()}
            />
          ) : null}
          {list.isError && options.length > 0 ? <Banner tone="danger" message={errorMessage(list.error)} /> : null}
        </>
      )}
    </>
  );
}

function LocalOptions({ options, selectedId, onSelect, onClose }: BodyProps & { readonly options: readonly PickOption[] }) {
  const [q, setQ] = useState('');
  const text = lower(q.trim());
  const shown = text === '' ? options : options.filter((o) => lower(o.gosterim).includes(text));
  return (
    <>
      {options.length >= LOCAL_SEARCH_FROM ? <SearchBox value={q} onChange={setQ} busy={false} autoFocus={false} /> : null}
      <OptionRows options={shown} selectedId={selectedId} onSelect={onSelect} onClose={onClose} empty="Eşleşen seçenek yok." />
    </>
  );
}

function SearchBox({ value, onChange, busy, autoFocus }: { readonly value: string; readonly onChange: (text: string) => void; readonly busy: boolean; readonly autoFocus: boolean }) {
  const { colors } = useTheme();
  return (
    <TextField
      label="Ara"
      value={value}
      onChangeText={onChange}
      placeholder="Kod ya da ad yazın"
      icon="search"
      autoFocus={autoFocus}
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="search"
      accessibilityLabel="Seçeneklerde ara"
      right={busy ? <ActivityIndicator color={colors.primary} accessibilityLabel="Aranıyor" /> : undefined}
    />
  );
}

function OptionRows({ options, selectedId, onSelect, onClose, empty }: BodyProps & { readonly options: readonly PickOption[]; readonly empty: string }) {
  const { colors } = useTheme();
  const motion = useMotion();
  if (options.length === 0) {
    return (
      <View style={styles.empty} accessibilityLiveRegion="polite">
        <Ionicons name="search-outline" size={22} color={colors.textFaint} />
        <Text variant="small" tone="muted">
          {empty}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.rows, { borderColor: colors.border }]}>
      {options.map((option, i) => {
        const selected = option.id === selectedId;
        return (
          <Animated.View key={option.id} entering={i < 12 ? motion.fadeIn : undefined}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={option.note === undefined ? option.gosterim : `${option.gosterim}, ${option.note}`}
              accessibilityState={{ selected }}
              onPress={() => {
                haptics.tap();
                onSelect(option);
                onClose();
              }}
              scaleTo={0.98}
              style={[
                styles.row,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                selected && { backgroundColor: colors.primarySoft },
              ]}
            >
              <View style={styles.flex}>
                <Text variant={selected ? 'bodyStrong' : 'body'} tone={selected ? 'primary' : 'default'}>
                  {option.gosterim}
                </Text>
                {option.note !== undefined ? (
                  <Text variant="caption" tone="warning">
                    {option.note}
                  </Text>
                ) : null}
              </View>
              {selected ? <Ionicons name="checkmark-circle" size={22} color={colors.primary} /> : null}
            </PressableScale>
          </Animated.View>
        );
      })}
    </View>
  );
}

function OptionSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="Seçenekler yükleniyor" accessibilityRole="progressbar">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} height={20} width={`${85 - (i % 3) * 15}%`} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  state: { gap: spacing.md },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  rows: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: minTouch + 4, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  skeleton: { gap: spacing.lg, paddingVertical: spacing.sm },
});
