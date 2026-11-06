import type { TextStyle } from 'react-native';

import type { MasrafDurum } from '@/api/types';

export interface Palette {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textFaint: string;
  readonly primary: string;
  /** Primary as text on surfaces and on primarySoft; lighter than primary in the dark theme so small text reads (WCAG AA). */
  readonly primaryText: string;
  readonly primarySoft: string;
  readonly onPrimary: string;
  /** Text and icons on a solid danger, success or warning fill (white in light, dark ink in dark, where those fills are bright). */
  readonly onAccent: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly success: string;
  readonly successSoft: string;
  readonly warning: string;
  readonly warningSoft: string;
  readonly info: string;
  readonly infoSoft: string;
  readonly skeleton: string;
  readonly overlay: string;
  readonly heroFrom: string;
  readonly heroTo: string;
  readonly onHero: string;
  readonly onHeroMuted: string;
  readonly tabBar: string;
}

const light: Palette = {
  bg: '#F6F5F1',
  surface: '#FFFFFF',
  surfaceAlt: '#EFEDE7',
  border: '#E3E0D8',
  text: '#16131F',
  textMuted: '#625F70',
  // Contrast (WCAG): textFaint ≥ 4.7 on bg and surface; warning and success ≥ 4.7 on their soft fills.
  textFaint: '#6E6B80',
  primary: '#5B3DF5',
  primaryText: '#5B3DF5',
  primarySoft: '#ECE8FF',
  onPrimary: '#FFFFFF',
  onAccent: '#FFFFFF',
  danger: '#C92F2F',
  dangerSoft: '#FCEBEB',
  success: '#137A4A',
  successSoft: '#E3F4EA',
  warning: '#9A5A00',
  warningSoft: '#FFF2D9',
  info: '#2058D6',
  infoSoft: '#E5EDFF',
  skeleton: '#E7E4DC',
  overlay: 'rgba(14, 11, 28, 0.48)',
  heroFrom: '#5B3DF5',
  heroTo: '#24157A',
  onHero: '#FFFFFF',
  onHeroMuted: 'rgba(255, 255, 255, 0.72)',
  tabBar: '#FFFFFF',
};

const dark: Palette = {
  bg: '#0D0B14',
  surface: '#17141F',
  surfaceAlt: '#221E2C',
  border: '#2E2A3A',
  text: '#F3F1F8',
  textMuted: '#ABA7B9',
  // Contrast (WCAG): textFaint ≥ 4.6 on bg, surface and surfaceAlt; primaryText ≥ 5.8 on surfaces and primarySoft.
  textFaint: '#8A869E',
  primary: '#6E55FF',
  primaryText: '#A493FF',
  primarySoft: '#272050',
  onPrimary: '#FFFFFF',
  onAccent: '#0D0B14',
  danger: '#FF6B6B',
  dangerSoft: '#3A1A1F',
  success: '#45D493',
  successSoft: '#11301F',
  warning: '#F4B547',
  warningSoft: '#372A10',
  info: '#73A7FF',
  infoSoft: '#152447',
  skeleton: '#24202E',
  overlay: 'rgba(0, 0, 0, 0.6)',
  heroFrom: '#4B30E0',
  heroTo: '#1A1050',
  onHero: '#FFFFFF',
  onHeroMuted: 'rgba(255, 255, 255, 0.7)',
  tabBar: '#17141F',
};

export const palettes = { light, dark } as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 28,
  pill: 999,
} as const;

/** Smallest touch target (points). */
export const minTouch = 44;

const tabular: TextStyle['fontVariant'] = ['tabular-nums'];

export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -0.8 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '800', letterSpacing: -0.5 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700', letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  label: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  small: { fontSize: 14, lineHeight: 19, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.2 },
  amount: { fontSize: 17, lineHeight: 22, fontWeight: '700', fontVariant: tabular, letterSpacing: -0.2 },
  amountLarge: { fontSize: 36, lineHeight: 42, fontWeight: '800', fontVariant: tabular, letterSpacing: -1 },
} as const satisfies Record<string, TextStyle>;

/**
 * An amount style scaled to the length of one formatted amount, so it stays on one line on a 360 pt screen
 * without depending on platform text fitting. Up to `fullChars` characters keep the full size.
 */
function scaledAmount(base: TextStyle & { fontSize: number }, text: string, fullChars: number, minSize: number): TextStyle {
  if (text.length <= fullChars) return base;
  const fontSize = Math.max(minSize, Math.floor((base.fontSize * fullChars) / text.length));
  return { ...base, fontSize, lineHeight: Math.round(fontSize * 1.25) };
}

/** amountLarge (hero and detail): "₺1.323.413,40" is shown slightly smaller, "₺999.999.999,99" still fits. */
export function amountLargeFor(text: string): TextStyle {
  return scaledAmount(typography.amountLarge, text, 12, 24);
}

/** amount in list rows: from 13 characters ("₺1.234.567,89") it shrinks a little so the title keeps room. */
export function amountFor(text: string): TextStyle {
  return scaledAmount(typography.amount, text, 12, 14);
}

export type TypographyVariant = keyof typeof typography;

export interface StatusColors {
  readonly fg: string;
  readonly bg: string;
}

/** One colour per form state, used by badges, counters and the timeline. */
export function statusColors(p: Palette, durum: MasrafDurum): StatusColors {
  switch (durum) {
    case 'taslak':
      return { fg: p.textMuted, bg: p.surfaceAlt };
    case 'onayda':
      return { fg: p.warning, bg: p.warningSoft };
    case 'onaylandi':
      return { fg: p.success, bg: p.successSoft };
    case 'reddedildi':
      return { fg: p.danger, bg: p.dangerSoft };
    case 'odendi':
      return { fg: p.info, bg: p.infoSoft };
    case 'iptal':
      return { fg: p.textFaint, bg: p.bg };
  }
}
