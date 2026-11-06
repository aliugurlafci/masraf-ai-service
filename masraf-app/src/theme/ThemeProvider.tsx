import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';

import { palettes, type Palette } from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface ThemeValue {
  readonly scheme: 'light' | 'dark';
  readonly colors: Palette;
  readonly preference: ThemePreference;
  readonly setPreference: (pref: ThemePreference) => void;
}

const PREFERENCE_KEY = 'masraf.tema';

const ThemeContext = createContext<ThemeValue | null>(null);

const isPreference = (value: string | null): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

/**
 * Light/dark theme. The user's choice overrides the system scheme through Appearance, so native
 * dialogs and pickers follow it too. The choice is not secret; it sits in SecureStore only because that
 * is the one key-value store the app ships with.
 */
export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const system = useColorScheme();

  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(PREFERENCE_KEY)
      .then((stored) => {
        if (alive && isPreference(stored) && stored !== 'system') {
          setPreferenceState(stored);
          Appearance.setColorScheme(stored);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const setPreference = (pref: ThemePreference): void => {
    setPreferenceState(pref);
    Appearance.setColorScheme(pref === 'system' ? 'auto' : pref);
    SecureStore.setItemAsync(PREFERENCE_KEY, pref).catch(() => undefined);
  };

  const scheme: 'light' | 'dark' = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
  const value: ThemeValue = { scheme, colors: palettes[scheme], preference, setPreference };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
