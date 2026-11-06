import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { ExpenseForm } from '@/components/form/ExpenseForm';
import type { InvoiceSource } from '@/lib/pickers';
import { useTheme } from '@/theme';

const SOURCES: readonly InvoiceSource[] = ['kamera', 'galeri', 'dosya'];

export default function NewExpenseScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ kaynak?: string }>();
  const autoSource = SOURCES.find((s) => s === params.kaynak);
  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
      <ExpenseForm
        mode="create"
        autoSource={autoSource}
        onDone={(detail) => router.replace({ pathname: '/masraf/[id]', params: { id: String(detail.id) } })}
      />
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
