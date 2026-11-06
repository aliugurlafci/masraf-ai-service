import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

import type { PickedFile } from '@/api/endpoints';

export type InvoiceSource = 'kamera' | 'galeri' | 'dosya';

function extensionOf(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

function fileNameFor(name: string | null | undefined, mime: string): string {
  if (name !== null && name !== undefined && name.trim() !== '') return name;
  return `fatura-${Date.now()}.${extensionOf(mime)}`;
}

function guessMime(uri: string, fallback: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return fallback;
}

function askForSettings(title: string, message: string): void {
  Alert.alert(title, message, [
    { text: 'Vazgeç', style: 'cancel' },
    { text: 'Ayarları aç', onPress: () => void Linking.openSettings() },
  ]);
}

/** Takes a photo of a receipt. Returns null when the user cancels or denies the camera. */
export async function pickFromCamera(): Promise<PickedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    askForSettings('Kamera izni gerekli', 'Fişinizi fotoğraflamak için ayarlardan kamera iznini açın.');
    return null;
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7, exif: false });
  return assetToFile(result);
}

/** Picks a receipt photo from the gallery (system photo picker; no permission needed). */
export async function pickFromLibrary(): Promise<PickedFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, exif: false });
  return assetToFile(result);
}

function assetToFile(result: ImagePicker.ImagePickerResult): PickedFile | null {
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined) return null;
  const mimeType = asset.mimeType ?? guessMime(asset.uri, 'image/jpeg');
  return { uri: asset.uri, name: fileNameFor(asset.fileName, mimeType), mimeType };
}

/** Picks a PDF (or an image file) from the device's files. */
export async function pickDocument(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'image/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined) return null;
  const mimeType = asset.mimeType ?? guessMime(asset.name, 'application/pdf');
  return { uri: asset.uri, name: fileNameFor(asset.name, mimeType), mimeType };
}

export function pickInvoice(source: InvoiceSource): Promise<PickedFile | null> {
  if (source === 'kamera') return pickFromCamera();
  if (source === 'galeri') return pickFromLibrary();
  return pickDocument();
}

export const isPdf = (mime: string | null | undefined): boolean => mime === 'application/pdf';
