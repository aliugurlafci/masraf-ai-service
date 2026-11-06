import { Tabs } from 'expo-router/js-tabs';
import { useReducedMotion } from 'react-native-reanimated';

import { useBen } from '@/api/queries';
import { TabBar } from '@/components/TabBar';
import { useTheme } from '@/theme';

export default function TabsLayout() {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  // Same cache entry as the auth provider: refreshed every minute and whenever the app comes to the front.
  const ben = useBen();
  const pending = ben.data?.bekleyenOnay ?? 0;
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        animation: reduced ? 'none' : 'shift',
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Ana sayfa' }} />
      <Tabs.Screen name="masraflar" options={{ title: 'Masraflarım' }} />
      <Tabs.Screen name="onaylar" options={{ title: 'Onaylar', tabBarBadge: pending > 0 ? pending : undefined }} />
      <Tabs.Screen name="profil" options={{ title: 'Profil' }} />
    </Tabs>
  );
}
