// Integration passwords at rest (docs/onay-sistemi.md, section 9, "Kurallar"): AES-256-GCM with a key
// derived from ENTEGRASYON_ANAHTARI. The database holds only the sealed bytes; the key stays in .env.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SecretBox {
  seal(plain: string): Buffer;
  /** The password, or null when the bytes were sealed with another key or are damaged. */
  open(sealed: Buffer): string | null;
}

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A box for `key` (ENTEGRASYON_ANAHTARI); null when no key is set, so no password can be stored. */
export function createSecretBox(key: string | null): SecretBox | null {
  if (key === null) return null;
  const secret = createHash('sha256').update(`masraf-entegrasyon:${key}`, 'utf8').digest();
  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(sealed) {
      if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) return null;
      try {
        const iv = sealed.subarray(1, 1 + IV_BYTES);
        const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv('aes-256-gcm', secret, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}
