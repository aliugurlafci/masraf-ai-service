import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import type { RefObject } from 'react';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, useTheme } from '@/theme';

import { IconButton } from './IconButton';
import { Text } from './Text';

const EXIT_MS = 240;

export interface SheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  /** Lets the content scroll to a field (e.g. the first empty required one). */
  readonly scrollRef?: RefObject<ScrollViewInstance | null>;
}

/**
 * Bottom sheet on a transparent modal. The content slides in on the UI thread; on close it slides out
 * before the modal is removed. Moves up with the keyboard.
 */
export function Sheet({ visible, onClose, title, subtitle, children, scrollRef }: SheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return undefined;
    }
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [visible, reduced]);

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {visible ? (
        <View style={styles.root}>
          <Animated.View
            entering={reduced ? undefined : FadeIn.duration(200)}
            exiting={reduced ? undefined : FadeOut.duration(EXIT_MS)}
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Kapat" />
          </Animated.View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.avoid} pointerEvents="box-none">
            <Animated.View
              entering={reduced ? undefined : SlideInDown.springify().damping(20).mass(0.7)}
              exiting={reduced ? undefined : SlideOutDown.duration(EXIT_MS)}
              accessibilityViewIsModal
              style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
            >
              <View style={[styles.handle, { backgroundColor: colors.border }]} />
              <View style={styles.header}>
                <View style={styles.headerText}>
                  <Text variant="heading" accessibilityRole="header">
                    {title}
                  </Text>
                  {subtitle !== undefined ? (
                    <Text variant="small" tone="muted">
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                <IconButton icon="close" onPress={onClose} accessibilityLabel="Kapat" tone="soft" />
              </View>
              <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} bounces={false}>
                {children}
              </ScrollView>
            </Animated.View>
          </KeyboardAvoidingView>
        </View>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  avoid: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    maxHeight: '90%',
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: radius.pill, marginBottom: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  headerText: { flex: 1, gap: spacing.xxs },
  content: { gap: spacing.lg, paddingBottom: spacing.sm },
});
