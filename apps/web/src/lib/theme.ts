// Light / dark / system theme preference (per browser; storage failures are ignored).

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'orc.theme';

export function readThemePreference(): ThemePreference {
  try {
    const value = globalThis.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemePreference(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  try {
    if (theme === 'system') {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } else {
      globalThis.localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    // Preference only lasts for this page view.
  }
}
