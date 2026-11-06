import * as SecureStore from 'expo-secure-store';

// The session token is kept only here (Keychain on iOS, Keystore-backed storage on Android).
const TOKEN_KEY = 'masraf.oturum';

export async function readToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Nothing stored or storage unavailable: the in-memory copy is cleared by the caller anyway.
  }
}
