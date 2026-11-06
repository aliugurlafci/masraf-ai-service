import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, type TextInputInstance } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Banner } from '@/components/ui/StateViews';
import { Text } from '@/components/ui/Text';
import { TextField } from '@/components/ui/TextField';
import { config } from '@/config';
import { useMotion } from '@/hooks/useMotion';
import { haptics } from '@/lib/haptics';
import { minTouch, radius, spacing, useTheme } from '@/theme';

export default function LoginScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const motion = useMotion();
  const { signIn, notice } = useAuth();
  const [eposta, setEposta] = useState('');
  const [sifre, setSifre] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInputInstance>(null);
  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }] }));

  const fail = (message: string): void => {
    setError(message);
    haptics.error();
    if (!motion.reduced) {
      shake.set(
        withSequence(
          withTiming(-10, { duration: 50 }),
          withTiming(10, { duration: 50 }),
          withTiming(-6, { duration: 50 }),
          withTiming(6, { duration: 50 }),
          withTiming(0, { duration: 50 }),
        ),
      );
    }
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (eposta.trim() === '' || sifre === '') {
      fail('E-posta ve şifre gerekli.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(eposta, sifre);
      haptics.success();
    } catch (err) {
      fail(errorMessage(err));
      setBusy(false);
    }
  };

  const message = error ?? notice;

  return (
    <KeyboardAvoidingView style={[styles.flex, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bounces={false}>
        <LinearGradient
          colors={[colors.heroFrom, colors.heroTo]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.hero, { paddingTop: insets.top + spacing.huge }]}
        >
          <Animated.View entering={motion.enter(0)} style={styles.logo}>
            <Ionicons name="receipt" size={34} color={colors.heroFrom} />
          </Animated.View>
          <Animated.View entering={motion.enter(1)}>
            <Text variant="display" tone="onHero">
              Masraf
            </Text>
            <Text tone="onHeroMuted" style={styles.tagline}>
              Fişi çek, formu gönder, onayı takip et.
            </Text>
          </Animated.View>
        </LinearGradient>

        <Animated.View entering={motion.enter(2)} style={[styles.card, shakeStyle, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text variant="heading" accessibilityRole="header">
            Giriş yap
          </Text>
          {message !== null ? <Banner tone={error !== null ? 'danger' : 'info'} message={message} /> : null}
          <TextField
            label="E-posta"
            icon="mail-outline"
            value={eposta}
            onChangeText={setEposta}
            placeholder="ad.soyad@firma.com"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            submitBehavior="submit"
          />
          <TextField
            ref={passwordRef}
            label="Şifre"
            icon="lock-closed-outline"
            value={sifre}
            onChangeText={setSifre}
            placeholder="••••••••"
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            right={
              <Pressable
                onPress={() => setShowPassword((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
                hitSlop={8}
                style={styles.eye}
              >
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.textMuted} />
              </Pressable>
            }
          />
          <Button title="Giriş yap" icon="log-in-outline" onPress={() => void submit()} loading={busy} />
        </Animated.View>

        <Text variant="caption" tone="faint" align="center" style={[styles.server, { marginBottom: insets.bottom + spacing.lg }]}>
          Sunucu: {config.apiUrl}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },
  hero: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.huge + spacing.xxxl,
    gap: spacing.xl,
    borderBottomLeftRadius: radius.xxl,
    borderBottomRightRadius: radius.xxl,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagline: { marginTop: spacing.xs },
  card: {
    marginHorizontal: spacing.xl,
    marginTop: -spacing.huge,
    padding: spacing.xl,
    borderRadius: radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.lg,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
  },
  eye: { width: minTouch, height: minTouch, alignItems: 'center', justifyContent: 'center', marginRight: -spacing.sm },
  server: { marginTop: spacing.xl },
});
