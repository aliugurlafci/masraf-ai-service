import { useSyncExternalStore } from 'react';

// Shared 1 s clock so render functions stay pure (no Date.now() during render).
let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) {
        l();
      }
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return current;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Seconds left until `anchorMs + seconds * 1000` (0 when elapsed or unknown). */
export function useCountdown(anchorMs: number, seconds: number | null): number {
  const now = useNow();
  if (seconds === null) {
    return 0;
  }
  // The shared clock may lag the anchor by up to one tick; never show more than `seconds`.
  return Math.min(seconds, Math.max(0, Math.ceil((anchorMs + seconds * 1000 - now) / 1000)));
}
