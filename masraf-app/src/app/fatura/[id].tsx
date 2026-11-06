import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { authHeaders } from '@/api/client';
import { invoiceFileUrl } from '@/api/endpoints';
import { PressableScale } from '@/components/ui/PressableScale';
import { Text } from '@/components/ui/Text';
import { haptics } from '@/lib/haptics';
import { minTouch, spacing } from '@/theme';

const MAX_SCALE = 5;
/** Downward drag (points) that closes the viewer when the photo is not zoomed. */
const DISMISS_DISTANCE = 120;
const SPRING = { damping: 20, stiffness: 200 } as const;

/** Full-screen invoice photo: pinch to zoom, drag to pan, double tap to zoom in or reset. */
export default function InvoiceViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const close = (): void => {
    haptics.tap();
    router.back();
  };

  const settle = (to: number, toX: number, toY: number): void => {
    'worklet';
    scale.set(reduced ? to : withSpring(to, SPRING));
    x.set(reduced ? toX : withSpring(toX, SPRING));
    y.set(reduced ? toY : withSpring(toY, SPRING));
    savedScale.set(to);
    savedX.set(toX);
    savedY.set(toY);
  };

  const pinch = usePinchGesture({
    onUpdate: (e) => {
      'worklet';
      scale.set(Math.min(MAX_SCALE, Math.max(0.8, savedScale.get() * e.scale)));
    },
    onDeactivate: () => {
      'worklet';
      if (scale.get() < 1) settle(1, 0, 0);
      else savedScale.set(scale.get());
    },
  });

  const pan = usePanGesture({
    minPointers: 1,
    onUpdate: (e) => {
      'worklet';
      if (scale.get() <= 1) {
        // Not zoomed: a downward drag dismisses, so follow the finger vertically only.
        y.set(Math.max(0, e.translationY));
        return;
      }
      x.set(savedX.get() + e.translationX);
      y.set(savedY.get() + e.translationY);
    },
    onDeactivate: (e) => {
      'worklet';
      if (scale.get() <= 1) {
        if (e.translationY > DISMISS_DISTANCE) {
          scheduleOnRN(close);
          return;
        }
        y.set(reduced ? 0 : withTiming(0, { duration: 180 }));
        return;
      }
      savedX.set(x.get());
      savedY.set(y.get());
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onDeactivate: () => {
      'worklet';
      if (savedScale.get() > 1) settle(1, 0, 0);
      else settle(2.5, 0, 0);
    },
  });

  const gestures = useExclusiveGestures(doubleTap, useSimultaneousGestures(pinch, pan));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  // Own root view: on iOS this screen is a native full-screen modal outside the app's root.
  return (
    <GestureHandlerRootView style={styles.root}>
      <GestureDetector gesture={gestures}>
        <Animated.View style={[styles.flex, imageStyle]}>
          <Image
            source={{ uri: invoiceFileUrl(id), headers: authHeaders(), cacheKey: `fatura-${id}` }}
            style={styles.flex}
            contentFit="contain"
            transition={200}
            accessibilityLabel="Fatura görseli"
            onLoad={() => setState('ready')}
            onError={() => setState('error')}
          />
        </Animated.View>
      </GestureDetector>

      {state === 'loading' ? <ActivityIndicator style={StyleSheet.absoluteFill} color="#FFFFFF" size="large" /> : null}
      {state === 'error' ? (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Ionicons name="image-outline" size={40} color="#FFFFFF" />
          <Text color="#FFFFFF" align="center">
            Fatura görseli yüklenemedi.
          </Text>
        </View>
      ) : null}

      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]} pointerEvents="box-none">
        <Text variant="caption" color="rgba(255,255,255,0.7)">
          Yakınlaştırmak için iki parmakla açın veya çift dokunun
        </Text>
        <PressableScale accessibilityRole="button" accessibilityLabel="Kapat" onPress={close} style={styles.close}>
          <Ionicons name="close" size={26} color="#FFFFFF" />
        </PressableScale>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  top: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  close: {
    width: minTouch,
    height: minTouch,
    borderRadius: minTouch / 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
