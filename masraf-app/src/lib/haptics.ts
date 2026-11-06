import * as Haptics from 'expo-haptics';

// Haptics are a nicety: a device without a vibrator (or the web) must never surface an error.
const ignore = (): void => undefined;

export const haptics = {
  tap: (): void => {
    Haptics.selectionAsync().catch(ignore);
  },
  press: (): void => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore);
  },
  success: (): void => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore);
  },
  warning: (): void => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(ignore);
  },
  error: (): void => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(ignore);
  },
};
