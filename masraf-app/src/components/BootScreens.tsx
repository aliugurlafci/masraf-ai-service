import { Ionicons } from '@expo/vector-icons';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { config } from '@/config';
import { radius, spacing, useTheme } from '@/theme';

import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Text } from './ui/Text';

/** Shown instead of the app when EXPO_PUBLIC_API_URL is missing or invalid. */
export function ConfigMissingScreen() {
  const { colors } = useTheme();
  const steps = [
    'masraf-app klasöründe env.example dosyasını .env adıyla kopyalayın (Windows: copy env.example .env).',
    'EXPO_PUBLIC_API_URL değerini sunucunun adresi yapın, örneğin http://127.0.0.1:4000.',
    'Android cihaz veya emülatörde: adb reverse tcp:4000 tcp:4000 komutunu çalıştırın.',
    'iPhone veya Wi-Fi\'deki telefonda: sunucunun .env dosyasına AG_ERISIMI=yerel ekleyin ve adres olarak sunucunun açılışta yazdığı http://192.168.x.x:4000 adresini kullanın.',
    'Metro\'yu önbelleği temizleyerek yeniden başlatın: npx expo start -c',
  ];
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.icon, { backgroundColor: colors.warningSoft }]}>
          <Ionicons name="settings-outline" size={32} color={colors.warning} />
        </View>
        <Text variant="title" accessibilityRole="header">
          Sunucu adresi ayarlanmamış
        </Text>
        <Text tone="muted">{config.apiUrlProblem ?? 'EXPO_PUBLIC_API_URL tanımlı değil.'}</Text>
        <Card style={styles.steps}>
          {steps.map((step, i) => (
            <View key={step} style={styles.step}>
              <View style={[styles.num, { backgroundColor: colors.primarySoft }]}>
                <Text variant="label" tone="primary">
                  {i + 1}
                </Text>
              </View>
              <Text style={styles.flex}>{step}</Text>
            </View>
          ))}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Shown when a stored session could not be checked because the server did not answer. */
export function UnreachableScreen({ message, onRetry, onSignOut }: { readonly message: string | null; readonly onRetry: () => void; readonly onSignOut: () => void }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: colors.bg }]}>
      <View style={[styles.content, styles.center]}>
        <View style={[styles.icon, { backgroundColor: colors.dangerSoft }]}>
          <Ionicons name="cloud-offline-outline" size={32} color={colors.danger} />
        </View>
        <Text variant="title" align="center" accessibilityRole="header">
          Sunucuya ulaşılamadı
        </Text>
        <Text tone="muted" align="center">
          {message ?? 'Sunucu yanıt vermedi.'}
        </Text>
        <Text variant="small" tone="faint" align="center">
          Adres: {config.apiUrl}
        </Text>
        <Button title="Tekrar dene" icon="refresh" onPress={onRetry} style={styles.button} />
        <Button title="Çıkış yap" variant="ghost" onPress={onSignOut} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xxl, gap: spacing.lg, flexGrow: 1 },
  center: { justifyContent: 'center', alignItems: 'center' },
  icon: { width: 64, height: 64, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  steps: { gap: spacing.lg },
  step: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  button: { alignSelf: 'stretch', marginTop: spacing.md },
});
