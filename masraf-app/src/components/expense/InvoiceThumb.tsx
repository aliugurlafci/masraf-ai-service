import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { authHeaders } from '@/api/client';
import { invoiceFileUrl } from '@/api/endpoints';
import { isPdf } from '@/lib/pickers';
import { radius, useTheme } from '@/theme';

export type InvoiceThumbSource =
  | { readonly kind: 'local'; readonly uri: string; readonly mime: string }
  | { readonly kind: 'remote'; readonly faturaId: string; readonly mime: string | null; readonly hasFile: boolean }
  /** A file the server holds but has no invoice record for yet (a pending invoice): only its type is shown. */
  | { readonly kind: 'icon'; readonly mime: string | null };

/** Small preview of an invoice: the photo itself, or a document icon for a PDF or a missing file. */
export function InvoiceThumb({ source, width = 64, height = 80, style }: { readonly source: InvoiceThumbSource; readonly width?: number; readonly height?: number; readonly style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const pdf = isPdf(source.mime);
  const showImage = !pdf && !failed && (source.kind === 'local' || (source.kind === 'remote' && source.hasFile));
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.box, { width, height, backgroundColor: colors.primarySoft, borderColor: colors.border }, style]}
    >
      {showImage ? (
        <Image
          source={source.kind === 'local' ? { uri: source.uri } : { uri: invoiceFileUrl(source.faturaId), headers: authHeaders(), cacheKey: `fatura-${source.faturaId}` }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={200}
          onError={() => setFailed(true)}
        />
      ) : (
        <Ionicons name={pdf ? 'document-text' : 'image-outline'} size={Math.round(width * 0.45)} color={colors.primary} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
