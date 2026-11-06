// Object URLs for invoice files. A blob: URL opens with the panel's own origin, so a file must never
// get one under a type the browser would run as a page (HTML, SVG, XML): a "PDF" named fatura.html
// would otherwise execute with the user's session. The type comes from the file's first bytes, the
// same check the server makes (src/invoice/file-type.ts); anything else is
// application/octet-stream, which the browser downloads instead of showing.

export const OCTET = 'application/octet-stream';

const SAFE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** A declared type (Content-Type, File.type, a record's mime) kept only when it is a safe one. */
export function safeType(type) {
  const t = String(type ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return SAFE_TYPES.has(t) ? t : OCTET;
}

const startsWith = (buf, bytes, offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/** Mirrors detectFileType in src/invoice/file-type.ts. */
function detectType(buf) {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  return null;
}

const pending = new WeakMap(); // Blob -> Promise<type>
const known = new WeakMap(); // Blob -> type, once read

/** The file's type by its content: a safe type or application/octet-stream. */
export function sniffType(blob) {
  let p = pending.get(blob);
  if (!p) {
    p = blob
      .slice(0, 16)
      .arrayBuffer()
      .then(
        (b) => detectType(new Uint8Array(b)) ?? OCTET,
        () => OCTET,
      )
      .then((type) => {
        known.set(blob, type);
        return type;
      });
    pending.set(blob, p);
  }
  return p;
}

/** The content type if sniffType has already finished for this blob, otherwise null. */
export const knownType = (blob) => known.get(blob) ?? null;

/** An object URL whose type is exactly `type` (made safe); revoke it with URL.revokeObjectURL. */
export function typedObjectUrl(blob, type) {
  const mime = safeType(type);
  return { url: URL.createObjectURL(new Blob([blob], { type: mime })), mime };
}

/** { url, mime } for a local file or a fetched blob, typed by its content. */
export async function safeObjectUrl(blob) {
  return typedObjectUrl(blob, await sniffType(blob));
}

/** An object URL for a download link (<a download>): never shown, whatever the blob's own type. */
export const downloadObjectUrl = (blob) => URL.createObjectURL(new Blob([blob], { type: OCTET }));
