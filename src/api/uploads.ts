import type { Request } from 'express';
import { HttpError } from '../errors.ts';
import type { TrackMeta } from '../reading/activity.ts';

export { HttpError };

export interface UploadedFile {
  readonly buffer: Buffer;
  readonly name: string;
}

const isMultipart = (req: Request): boolean => (req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');

async function parseForm(req: Request, body: Buffer): Promise<FormData> {
  try {
    return await new globalThis.Request('http://127.0.0.1/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new HttpError(400, 'gecersiz_form', 'multipart/form-data gövdesi çözümlenemedi.');
  }
}

function requestBody(req: Request): Buffer {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new HttpError(400, 'dosya_yok', 'Fatura dosyası gönderilmedi.');
  }
  return body;
}

/** Accepts `multipart/form-data` (field "file") or the raw file as the request body. */
export async function readUpload(req: Request): Promise<UploadedFile> {
  const body = requestBody(req);
  if (isMultipart(req)) {
    const file = (await parseForm(req, body)).get('file');
    if (!(file instanceof File)) {
      throw new HttpError(400, 'dosya_yok', 'Formda "file" alanında bir dosya bulunamadı.');
    }
    return { buffer: Buffer.from(await file.arrayBuffer()), name: file.name };
  }
  const headerName = req.headers['x-file-name'];
  let name = 'fatura';
  if (typeof headerName === 'string' && headerName !== '') {
    try {
      name = decodeURIComponent(headerName);
    } catch {
      name = headerName;
    }
  }
  return { buffer: body, name };
}

/** Every file part of a multipart body, whatever the field is called ("file", "files", "files[]"). */
export async function readBatchUpload(req: Request): Promise<UploadedFile[]> {
  const body = requestBody(req);
  if (!isMultipart(req)) {
    throw new HttpError(400, 'gecersiz_form', 'Çoklu yükleme multipart/form-data olarak gönderilmelidir.');
  }
  const files: UploadedFile[] = [];
  for (const [, value] of await parseForm(req, body)) {
    if (value instanceof File) files.push({ buffer: Buffer.from(await value.arrayBuffer()), name: value.name || 'fatura' });
  }
  return files;
}

export const wantsRefresh = (req: Request): boolean => ['1', 'true', 'evet'].includes(String(req.query.yenile ?? '').toLowerCase());

const PANEL_TAG = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The panel tags its uploads with X-Panel-Etiket so the live monitor can tell them apart and the panel
 * can match each row to the file it sent. Anything without the tag counts as an API client.
 */
export function senderOf(req: Request): TrackMeta {
  const tag = req.headers['x-panel-etiket'];
  return typeof tag === 'string' && PANEL_TAG.test(tag) ? { kaynak: 'panel', etiket: tag } : { kaynak: 'api', etiket: null };
}
