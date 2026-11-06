import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type TextInputInstance } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, errorMessage } from '@/api/client';
import { changePassword } from '@/api/endpoints';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Banner } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { useToast } from '@/components/ui/Toast';
import { useMotion } from '@/hooks/useMotion';
import { haptics } from '@/lib/haptics';
import { radius, spacing, useTheme } from '@/theme';

type Fields = 'mevcutSifre' | 'yeniSifre' | 'tekrar';

export default function ChangePasswordScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const motion = useMotion();
  const toast = useToast();
  const { user, refreshUser, signOut } = useAuth();
  const forced = user?.sifreDegismeli === true;
  // Whether the screen opened as the mandatory step after login; it then leaves once the flag clears.
  const [startedForced] = useState(forced);
  const [changed, setChanged] = useState(false);
  const [mevcutSifre, setMevcut] = useState('');
  const [yeniSifre, setYeni] = useState('');
  const [tekrar, setTekrar] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const newRef = useRef<TextInputInstance>(null);
  const repeatRef = useRef<TextInputInstance>(null);

  // The guard opens the tabs only after the refreshed user no longer has sifreDegismeli.
  useEffect(() => {
    if (startedForced && changed && !forced) router.replace('/');
  }, [startedForced, changed, forced]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const local: Partial<Record<Fields, string>> = {};
    if (mevcutSifre === '') local.mevcutSifre = 'Mevcut şifrenizi girin.';
    if (yeniSifre === '') local.yeniSifre = 'Yeni şifrenizi girin.';
    if (tekrar !== yeniSifre) local.tekrar = 'Şifreler aynı değil.';
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) {
      haptics.error();
      return;
    }
    setBusy(true);
    try {
      await changePassword({ mevcutSifre, yeniSifre });
      haptics.success();
      toast('Şifreniz değiştirildi.', 'success');
      setChanged(true);
      await refreshUser();
      if (!startedForced) router.back();
    } catch (err) {
      haptics.error();
      if (err instanceof ApiError) {
        const fieldErrors: Partial<Record<Fields, string>> = {};
        if (err.alanlar.mevcutSifre !== undefined) fieldErrors.mevcutSifre = err.alanlar.mevcutSifre;
        if (err.alanlar.yeniSifre !== undefined) fieldErrors.yeniSifre = err.alanlar.yeniSifre;
        if (err.kod === 'hatali_sifre' && fieldErrors.mevcutSifre === undefined) fieldErrors.mevcutSifre = err.message;
        setErrors(fieldErrors);
        if (Object.keys(fieldErrors).length === 0) setFormError(err.message);
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={[styles.flex, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: startedForced ? insets.top + spacing.xxl : spacing.lg, paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        {startedForced ? (
          <Animated.View entering={motion.enter(0)} style={styles.intro}>
            <View style={[styles.icon, { backgroundColor: colors.primarySoft }]}>
              <Ionicons name="key-outline" size={30} color={colors.primary} />
            </View>
            <Text variant="title" accessibilityRole="header">
              Yeni şifre belirleyin
            </Text>
            <Text tone="muted">Hesabınız yönetici tarafından oluşturuldu veya şifreniz sıfırlandı. Devam etmek için kendi şifrenizi belirleyin.</Text>
          </Animated.View>
        ) : (
          <Text tone="muted">Şifreniz değişince diğer cihazlardaki oturumlarınız kapanır.</Text>
        )}

        {formError !== null ? <Banner tone="danger" message={formError} /> : null}

        <Animated.View entering={motion.enter(1)} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextField
            label="Mevcut şifre"
            icon="lock-closed-outline"
            value={mevcutSifre}
            onChangeText={setMevcut}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            error={errors.mevcutSifre}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => newRef.current?.focus()}
          />
          <TextField
            ref={newRef}
            label="Yeni şifre"
            icon="key-outline"
            value={yeniSifre}
            onChangeText={setYeni}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            error={errors.yeniSifre}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => repeatRef.current?.focus()}
          />
          <TextField
            ref={repeatRef}
            label="Yeni şifre (tekrar)"
            icon="key-outline"
            value={tekrar}
            onChangeText={setTekrar}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            error={errors.tekrar}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          <Button title="Şifreyi değiştir" icon="checkmark" onPress={() => void submit()} loading={busy} />
        </Animated.View>

        {startedForced ? <Button title="Çıkış yap" variant="ghost" icon="log-out-outline" onPress={() => void signOut()} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: spacing.xl, gap: spacing.lg },
  intro: { gap: spacing.md },
  icon: { width: 60, height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  card: { padding: spacing.xl, borderRadius: radius.xxl, borderWidth: StyleSheet.hairlineWidth, gap: spacing.lg },
});
