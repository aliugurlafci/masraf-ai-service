import { describe, expect, it } from 'vitest';
import { detectFileType } from '../../src/invoice/file-type.ts';

const bytes = (...b: number[]): Buffer => Buffer.from(b);

describe('detectFileType', () => {
  it.each([
    ['pdf', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'image/png'],
    ['jpg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['webp', Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    ['gif', Buffer.from('GIF89a'), 'image/gif'],
  ])('detects %s by content', (ext, buf, mime) => {
    expect(detectFileType(buf)).toEqual({ mime, ext });
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['text', Buffer.from('hello')],
    ['zip/docx', bytes(0x50, 0x4b, 0x03, 0x04)],
    ['RIFF without WEBP', Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WAVE')])],
    ['truncated png', bytes(0x89, 0x50, 0x4e)],
  ])('rejects %s', (_name, buf) => {
    expect(detectFileType(buf)).toBeNull();
  });
});
