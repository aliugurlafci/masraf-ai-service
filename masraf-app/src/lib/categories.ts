import type { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

export type CategoryIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

const ICONS: Readonly<Record<string, CategoryIconName>> = {
  yemek: 'silverware-fork-knife',
  ulasim: 'bus',
  konaklama: 'bed',
  akaryakit: 'gas-station',
  ofis: 'briefcase-outline',
  temsil: 'handshake-outline',
  egitim: 'school-outline',
  iletisim: 'phone-outline',
  diger: 'dots-horizontal-circle-outline',
};

/** Icon for a category's `simge`; unknown or empty values get a neutral shape. */
export function categoryIcon(simge: string | null | undefined): CategoryIconName {
  return (simge !== null && simge !== undefined ? ICONS[simge] : undefined) ?? 'shape-outline';
}
