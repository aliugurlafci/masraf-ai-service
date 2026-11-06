export interface DetectedFile {
  readonly mime: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly ext: 'pdf' | 'png' | 'jpg' | 'webp' | 'gif';
}

function startsWith(buf: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/**
 * Identifies the file by its content (magic bytes), never by the name or the
 * Content-Type the client sent. Returns null for anything that is not a
 * supported invoice format.
 */
export function detectFileType(buf: Uint8Array): DetectedFile | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: 'pdf' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', ext: 'gif' };
  return null;
}
