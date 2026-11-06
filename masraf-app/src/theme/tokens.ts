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
  readonly primarySoft: string;
  readonly onPrimary: string;
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
  textFaint: '#8F8C9C',
  primary: '#5B3DF5',
  primarySoft: '#ECE8FF',
  onPrimary: '#FFFFFF',
  danger: '#C92F2F',
  dangerSoft: '#FCEBEB',
  success: '#157F4E',
  successSoft: '#E3F4EA',
  warning: '#A86200',
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
  textFaint: '#77738A',
  primary: '#6E55FF',
  primarySoft: '#272050',
  onPrimary: '#FFFFFF',
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
