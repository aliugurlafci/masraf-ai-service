import { Ionicons } from '@expo/vector-icons';
import { Fragment } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { errorMessage } from '@/api/client';
import { useOnizleme } from '@/api/queries';
import type { OnizlemeIstegi } from '@/api/types';
import { Text } from '@/components/ui/Text';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMotion } from '@/hooks/useMotion';
import { formatMoney } from '@/lib/format';
import { radius, spacing, useTheme } from '@/theme';

/**
 * "This expense will go to: Ayşe → Mehmet". Asks the server (POST /api/onay-akisi/onizle) after the
 * amount has stopped changing; the app never computes the route itself.
 */
export function ApprovalPreview({ request }: { readonly request: OnizlemeIstegi | null }) {
  const { colors } = useTheme();
  const motion = useMotion();
  // Debounce a string key: the request object is new on every render, its content is what matters.
  const key = request === null ? null : JSON.stringify(request);
  const debouncedKey = useDebouncedValue(key, 500);
  const debounced = debouncedKey === null ? null : (JSON.parse(debouncedKey) as OnizlemeIstegi);
  const preview = useOnizleme(debounced);

  if (request === null) return null;

  const data = preview.data;
  const loading = preview.isFetching || debouncedKey !== key;
  return (
    <Animated.View
      entering={motion.fadeIn}
      layout={motion.layout}
      style={[styles.wrap, { backgroundColor: colors.primarySoft }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.head}>
        <Ionicons name="git-merge-outline" size={18} color={colors.primary} />
        <Text variant="label" tone="primary" style={styles.flex}>
          Bu masraf şu onaycılara gidecek
        </Text>
        {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      </View>
      {preview.isError && data === undefined ? (
        <Text variant="small" tone="danger">
          {errorMessage(preview.error)}
        </Text>
      ) : data === undefined ? (
        <Text variant="small" tone="muted">
          Hesaplanıyor…
        </Text>
      ) : data.adimlar.length === 0 ? (
        <Text variant="small" tone="muted">
          {data.uyari ?? 'Bu tutar için onaycı bulunamadı.'}
        </Text>
      ) : (
        <>
          {data.akis !== null ? (
            <Text variant="caption" tone="muted">
              {data.akis.ad} onay akışına göre
            </Text>
          ) : null}
          <View style={[styles.route, loading && styles.stale]} accessibilityLabel={`Onaycılar: ${data.adimlar.map((a) => a.onayci.adSoyad).join(', ')}`}>
            {data.adimlar.map((step, i) => {
              const skipped = step.durum === 'atlandi';
              return (
                <Fragment key={`${step.sira}-${step.onayci.id}`}>
                  {i > 0 ? <Ionicons name="arrow-forward" size={14} color={colors.textMuted} /> : null}
                  <View style={[styles.person, { backgroundColor: colors.surface }]}>
                    <Text variant="label" style={skipped ? styles.skipped : undefined} tone={skipped ? 'faint' : 'default'}>
                      {step.onayci.adSoyad}
                    </Text>
                    {skipped ? (
                      <Text variant="caption" tone="faint">
                        (siz, atlanır)
                      </Text>
                    ) : null}
                    {step.yedek ? (
                      <Text variant="caption" tone="warning">
                        yedek
                      </Text>
                    ) : null}
                  </View>
                </Fragment>
              );
            })}
          </View>
        </>
      )}
      {data !== undefined && debounced !== null && data.onayTutari !== debounced.tutar ? (
        <Text variant="caption" tone="muted">
          Onay tutarı: {formatMoney(data.onayTutari, data.paraBirimi)}
        </Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
  route: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs + 2 },
  stale: { opacity: 0.6 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm + 2, paddingVertical: spacing.xs + 1, borderRadius: radius.pill },
  skipped: { textDecorationLine: 'line-through' },
});
