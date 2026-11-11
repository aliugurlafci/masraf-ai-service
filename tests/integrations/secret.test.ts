// Integration passwords at rest (docs/onay-sistemi.md, section 9, "Kurallar").
import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../../src/integrations/secret.ts';

const KEY = 'k'.repeat(32);

describe('integration password box', () => {
  it('seals and opens a password, never storing it in clear', () => {
    const box = createSecretBox(KEY);
    if (box === null) throw new Error('kutu yok');
    const sealed = box.seal('Gizli Şifre 123');
    expect(sealed.includes(Buffer.from('Gizli'))).toBe(false);
    expect(box.open(sealed)).toBe('Gizli Şifre 123');
    // A new IV every time.
    expect(box.seal('Gizli Şifre 123').equals(sealed)).toBe(false);
  });

  it('opens nothing sealed with another key, damaged or unknown', () => {
    const sealed = createSecretBox(KEY)?.seal('parola') ?? Buffer.alloc(0);
    expect(createSecretBox('x'.repeat(32))?.open(sealed)).toBeNull();
    const damaged = Buffer.from(sealed);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    expect(createSecretBox(KEY)?.open(damaged)).toBeNull();
    expect(createSecretBox(KEY)?.open(Buffer.from([2, ...sealed.subarray(1)]))).toBeNull();
    expect(createSecretBox(KEY)?.open(Buffer.alloc(5))).toBeNull();
  });

  it('has no box without a key', () => {
    expect(createSecretBox(null)).toBeNull();
  });
});
