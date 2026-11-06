import { FadeIn, FadeInDown, FadeOut, LinearTransition, useReducedMotion } from 'react-native-reanimated';

/**
 * Shared animation presets. Every preset turns into "no animation" when the system's reduce-motion
 * setting is on, so screens never have to check it themselves.
 */
export function useMotion() {
  const reduced = useReducedMotion();
  return {
    reduced,
    /** List and card entrance: fade in from below, staggered by position (capped so long lists stay fast). */
    enter: (index = 0) =>
      reduced ? undefined : FadeInDown.duration(360).delay(Math.min(index, 8) * 50).springify().damping(18).mass(0.8),
    fadeIn: reduced ? undefined : FadeIn.duration(220),
    fadeOut: reduced ? undefined : FadeOut.duration(160),
    layout: reduced ? undefined : LinearTransition.springify().damping(20).mass(0.8),
  };
}
