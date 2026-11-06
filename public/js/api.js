// Calls to the service (docs/onay-sistemi.md, sections 5–6). The session travels in an HttpOnly
// cookie; nothing here stores a token. A 401 anywhere (except the login call itself) hands control
// to the handler registered with onUnauthorized, which shows the login screen.
//
// Every invoice upload carries a fresh panel tag (X-Panel-Etiket), so the live monitor can tell
// panel sends from API sends and the panel can match a row to the file it sent.

export const ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{8}$/;

// Sends are split so one multi-file request stays under the server's limits.
const BATCH_MAX_FILES = 50;
const BATCH_MAX_BYTES = 150 * 1024 * 1024;

const OFFLINE = { kod: 'baglanti', mesaj: 'Sunucuya ulaşılamadı. Servisin çalıştığından emin olun (npm start).' };
const ABORTED = { kod: 'iptal', mesaj: 'İstek iptal edildi.' };

const records = new Map(); // record id -> response body; a record never changes once written

let unauthorized = null;

/** fn() runs when the server answers 401 to any call made with a session. */
export function onUnauthorized(fn) {
  unauthorized = fn;
}

export function newTag() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** { kod, mesaj, alanlar, sorunlar, durum }: mesaj is always Turkish and safe to show. */
function errorOf(res, body) {
  const h = body?.hata;
  return {
    kod: h?.kod ?? `http_${res.status}`,
    mesaj: h?.mesaj ?? `Sunucu ${res.status} durum koduyla yanıt verdi.`,
    alanlar: h?.alanlar && typeof h.alanlar === 'object' ? h.alanlar : null,
    sorunlar: Array.isArray(h?.sorunlar) ? h.sorunlar : null,
    durum: res.status,
  };
}

/**
 * Result: { ok: true, res, body } or { ok: false, res, error, unauthorized?, aborted? }.
 * `auth: false` keeps a 401 local (the login form shows it instead of bouncing to the login screen).
 */
async function call(url, init = {}, { auth = true } = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, res: null, aborted: true, error: ABORTED };
    return { ok: false, res: null, error: OFFLINE };
  }
  if (res.status === 401 && auth) {
    const body = await res.json().catch(() => null);
    unauthorized?.();
    return { ok: false, res, unauthorized: true, error: errorOf(res, body) };
  }
  if (res.status === 204 || res.status === 205) {
    return res.ok ? { ok: true, res, body: null } : { ok: false, res, error: errorOf(res, null) };
  }
  const body = await res.json().catch(() => null);
  if (init.signal?.aborted) return { ok: false, res, aborted: true, error: ABORTED };
  return res.ok && body !== null ? { ok: true, res, body } : { ok: false, res, error: errorOf(res, body) };
}

function qs(params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const get = (url, { signal, auth } = {}) => call(url, { signal }, { auth });

function send(method, url, body, { signal, auth } = {}) {
  const init = { method, signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return call(url, init, { auth });
}

const seg = (v) => encodeURIComponent(String(v));

/** Fetches a file (CSV export, an invoice original) as a Blob with the same 401 handling. */
async function fetchBlob(url, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', signal });
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true, error: ABORTED };
    return { ok: false, error: OFFLINE };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 401) {
      unauthorized?.();
      return { ok: false, unauthorized: true, error: errorOf(res, body) };
    }
    return { ok: false, notFound: res.status === 404, error: errorOf(res, body) };
  }
  try {
    const blob = await res.blob();
    return { ok: true, blob, type: res.headers.get('Content-Type') ?? blob.type, disposition: res.headers.get('Content-Disposition') };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true, error: ABORTED };
    return { ok: false, error: OFFLINE };
  }
}

/** Forgets everything cached for the previous user. */
export function clearCache() {
  records.clear();
}

// ---------- Session and profile ----------

export const login = (eposta, sifre) => send('POST', '/api/oturum', { eposta, sifre, istemci: 'panel' }, { auth: false });
export const logout = () => send('DELETE', '/api/oturum', undefined, { auth: false });
export const me = (opts) => get('/api/ben', opts);
export const changeMyPassword = (mevcutSifre, yeniSifre) => send('PUT', '/api/ben/sifre', { mevcutSifre, yeniSifre });
export const summary = (opts) => get('/api/ozet', opts);

// ---------- Users (yonetici) ----------

export const listUsers = (params, opts) => get(`/api/kullanicilar${qs(params)}`, opts);
export const createUser = (data) => send('POST', '/api/kullanicilar', data);
export const updateUser = (id, data) => send('PATCH', `/api/kullanicilar/${seg(id)}`, data);
export const resetUserPassword = (id, yeniSifre) => send('POST', `/api/kullanicilar/${seg(id)}/sifre`, { yeniSifre });
export const listAudit = (adet, opts) => get(`/api/denetim${qs({ adet })}`, opts);

// ---------- Approval flows (yonetici; the preview is for everyone) ----------

/** Akis[]: the default flow first, then by name. */
export const listFlows = (opts) => get('/api/onay-akislari', opts);
export const getFlow = (id, opts) => get(`/api/onay-akislari/${seg(id)}`, opts);
/** { ad, adimlar: [{ onayciId, altLimit, ustLimit }] } (array order = approval order) → 201 Akis. */
export const createFlow = (data) => send('POST', '/api/onay-akislari', data);
/** { ad, adimlar }: replaces the whole flow. */
export const updateFlow = (id, data) => send('PUT', `/api/onay-akislari/${seg(id)}`, data);
export const setDefaultFlow = (id) => send('POST', `/api/onay-akislari/${seg(id)}/varsayilan`);
/** 204; users assigned to the flow fall back to the default one. 409 varsayilan_akis for the default. */
export const deleteFlow = (id) => send('DELETE', `/api/onay-akislari/${seg(id)}`);
/**
 * { tutar, paraBirimi?, kur?, faturaId?, akisId? } → who would approve it if the signed-in user sent
 * it. akisId (yonetici only) tries a saved flow other than the user's own.
 */
export const previewFlow = (data, opts) => send('POST', '/api/onay-akisi/onizle', data, opts);

// ---------- Categories ----------

export const listCategories = (all, opts) => get(`/api/kategoriler${all ? '?tumu=1' : ''}`, opts);
export const createCategory = (data) => send('POST', '/api/kategoriler', data);
export const updateCategory = (id, data) => send('PATCH', `/api/kategoriler/${seg(id)}`, data);

// ---------- Expenses ----------

/** { kapsam: 'benim'|'tumu', durum: 'onayda,taslak', q, sayfa, adet } */
export const listExpenses = (params, opts) => get(`/api/masraflar${qs(params)}`, opts);
export const getExpense = (id, opts) => get(`/api/masraflar/${seg(id)}`, opts);
export const createExpense = (data) => send('POST', '/api/masraflar', data);
export const updateExpense = (id, data) => send('PATCH', `/api/masraflar/${seg(id)}`, data);

/** action: gonder | geri-cek | iptal | onayla | reddet | odendi | devret */
export const expenseAction = (id, action, body) => send('POST', `/api/masraflar/${seg(id)}/${action}`, body);

/** durum: bekleyen | karar */
export const listApprovals = (durum, opts) => get(`/api/onaylar${qs({ durum })}`, opts);

/** CSV of all expenses: { durum?, baslangic?, bitis? } → { ok, blob, filename }. */
export async function exportExpenses(params) {
  const r = await fetchBlob(`/api/masraflar/disa-aktar${qs(params)}`);
  if (!r.ok) return r;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.disposition ?? '');
  let filename = null;
  try {
    filename = m ? decodeURIComponent(m[1]) : null;
  } catch {
    filename = null;
  }
  return { ...r, filename };
}

// ---------- Invoices ----------

export const invoiceFileUrl = (id) => `/api/invoices/${seg(id)}/dosya`;

/** The original file of a record as a Blob; notFound for old records without one. */
export const getInvoiceFile = (id, opts) => fetchBlob(invoiceFileUrl(id), opts);

/** One file; the request stays open until Claude has read it (or the stored result is found). */
export async function sendOne(file, { force, tag }) {
  const form = new FormData();
  form.append('file', file);
  const r = await call(force ? '/api/invoices?yenile=1' : '/api/invoices', {
    method: 'POST',
    body: form,
    headers: { 'X-Panel-Etiket': tag },
  });
  if (!r.ok) return r;
  const id = r.res.headers.get('X-Fatura-Id');
  if (id) records.set(id, r.body);
  return { ...r, id };
}

/** Several files; the server answers once each one is read from the records, refused or queued. */
export function sendMany(files, { force, tag }) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return call(force ? '/api/invoices/toplu?yenile=1' : '/api/invoices/toplu', {
    method: 'POST',
    body: form,
    headers: { 'X-Panel-Etiket': tag },
  });
}

export function splitForSending(files) {
  const groups = [];
  let group = [];
  let bytes = 0;
  for (const file of files) {
    if (group.length > 0 && (group.length >= BATCH_MAX_FILES || bytes + file.size > BATCH_MAX_BYTES)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(file);
    bytes += file.size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export const cachedRecord = (id) => records.get(id) ?? null;

export async function getRecord(id, opts) {
  const hit = records.get(id);
  if (hit) return { ok: true, body: hit };
  if (!ID_PATTERN.test(id)) return { ok: false, error: { kod: 'bulunamadi', mesaj: 'Kayıt bulunamadı.' } };
  const r = await get(`/api/invoices/${seg(id)}`, opts);
  if (r.ok) records.set(id, r.body);
  return r;
}

export async function listRecords() {
  const r = await call('/api/invoices');
  return r.ok && Array.isArray(r.body) ? r.body : null;
}
