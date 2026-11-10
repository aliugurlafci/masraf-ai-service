import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useMasraf } from '@/api/queries';
import { ExpenseForm } from '@/components/form/ExpenseForm';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/StateViews';
import { spacing, useTheme } from '@/theme';

export default function EditExpenseScreen() {
  const { colors } = useTheme();
  const { id, fatura } = useLocalSearchParams<{ id: string; fatura?: string }>();
  const masraf = useMasraf(Number(id));

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
      {/* A failed background refresh (the form is asked again while invoices are read) keeps the form
          on screen with what the user entered; only a first load that failed shows the error. */}
      {masraf.data === undefined ? (
        masraf.isError ? (
          <ErrorState error={masraf.error} onRetry={() => void masraf.refetch()} />
        ) : (
          <View style={styles.pad}>
            <ListSkeleton count={4} />
          </View>
        )
      ) : !masraf.data.izinler.duzenle ? (
        <EmptyState
          icon="lock-closed-outline"
          title="Bu masraf düzenlenemez"
          message="Bu masrafın şu anki durumunda düzenleme yetkiniz yok."
          actionTitle="Geri dön"
          onAction={() => router.back()}
        />
      ) : (
        <ExpenseForm mode="edit" initial={masraf.data} focusInvoice={fatura} onDone={() => router.back()} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pad: { padding: spacing.xl },
});
