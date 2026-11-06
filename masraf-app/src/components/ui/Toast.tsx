import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, useTheme } from '@/theme';

import type { IconName } from './Button';
import { Text } from './Text';

export type ToastTone = 'success' | 'danger' | 'info';

interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
}

type ShowToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Short, non-blocking messages at the top of the screen (success after an action, errors). */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const nextId = useRef(1);

  const show: ShowToast = (message, tone = 'info') => {
    const id = nextId.current++;
    setToast({ id, message, tone });
    AccessibilityInfo.announceForAccessibility(message);
  };

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {toast !== null ? <ToastView key={toast.id} item={toast} onDismiss={() => setToast(null)} /> : null}
      </View>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { readonly item: ToastItem; readonly onDismiss: () => void }) {
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const looks: Record<ToastTone, { icon: IconName; fg: string }> = {
    success: { icon: 'checkmark-circle', fg: colors.success },
    danger: { icon: 'alert-circle', fg: colors.danger },
    info: { icon: 'information-circle', fg: colors.info },
  };
  const look = looks[item.tone];
  return (
    <Animated.View
      entering={reduced ? undefined : FadeInUp.springify().damping(18)}
      exiting={reduced ? undefined : FadeOutUp.duration(180)}
      style={[styles.wrap, { top: insets.top + spacing.sm }]}
    >
      <Pressable
        onPress={onDismiss}
        accessibilityRole="alert"
        accessibilityHint="Kapatmak için dokunun"
        style={[
          styles.toast,
          {
            backgroundColor: scheme === 'dark' ? colors.surfaceAlt : colors.text,
            borderColor: colors.border,
          },
        ]}
      >
        <Ionicons name={look.icon} size={22} color={look.fg} />
        <Text variant="label" color={scheme === 'dark' ? colors.text : colors.bg} style={styles.text}>
          {item.message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (show === null) throw new Error('useToast must be used inside ToastProvider');
  return show;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 560,
    minHeight: 48,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  text: { flexShrink: 1 },
});
