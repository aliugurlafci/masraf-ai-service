import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavigationThemeProvider, type Theme } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';

import { createQueryClient, useAppFocusManager } from '@/api/queries';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { ConfigMissingScreen, UnreachableScreen } from '@/components/BootScreens';
import { ToastProvider } from '@/components/ui/Toast';
import { config } from '@/config';
import { ThemeProvider, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  useAppFocusManager();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        {config.apiUrl === null ? (
          <SplashGate ready>
            <ConfigMissingScreen />
          </SplashGate>
        ) : (
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <ToastProvider>
                <RootNavigator />
              </ToastProvider>
            </AuthProvider>
          </QueryClientProvider>
        )}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function SplashGate({ ready, children }: { readonly ready: boolean; readonly children: ReactNode }) {
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  return ready ? children : null;
}

function RootNavigator() {
  const { colors, scheme } = useTheme();
  const auth = useAuth();
  const reduced = useReducedMotion();
  const signedIn = auth.status === 'signedIn' && auth.user !== null;
  const mustChangePassword = signedIn && auth.user?.sifreDegismeli === true;

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navigationTheme: Theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.bg,
      card: colors.bg,
      text: colors.text,
      border: colors.border,
      notification: colors.danger,
    },
  };

  if (auth.status === 'unreachable') {
    return (
      <SplashGate ready>
        <UnreachableScreen message={auth.notice} onRetry={auth.retry} onSignOut={() => void auth.signOut()} />
      </SplashGate>
    );
  }

  return (
    <SplashGate ready={auth.status !== 'loading'}>
      <NavigationThemeProvider value={navigationTheme}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { color: colors.text, fontWeight: '700' },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            animation: reduced ? 'none' : 'default',
          }}
        >
          <Stack.Protected guard={signedIn && !mustChangePassword}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="masraf/yeni"
              options={{ headerShown: true, title: 'Yeni masraf', animation: reduced ? 'none' : 'slide_from_bottom' }}
            />
            <Stack.Screen name="masraf/[id]/index" options={{ headerShown: true, title: 'Masraf' }} />
            <Stack.Screen name="masraf/[id]/duzenle" options={{ headerShown: true, title: 'Masrafı düzenle' }} />
            <Stack.Screen
              name="fatura/[id]"
              options={{ presentation: 'fullScreenModal', animation: reduced ? 'none' : 'fade', contentStyle: { backgroundColor: '#000' } }}
            />
          </Stack.Protected>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="sifre" options={{ headerShown: !mustChangePassword, title: 'Şifre değiştir' }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="giris" options={{ animation: reduced ? 'none' : 'fade' }} />
          </Stack.Protected>
        </Stack>
      </NavigationThemeProvider>
    </SplashGate>
  );
}
