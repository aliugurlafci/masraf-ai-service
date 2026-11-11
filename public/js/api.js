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

/** The file name of a Content-Disposition header (filename*= or filename=), or null. */
function filenameOf(disposition) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  try {
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
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
/** { mailBildirim: boolean } → Kullanici. In-app notifications cannot be turned off. */
export const updatePreferences = (data) => send('PUT', '/api/ben/tercihler', data);

// ---------- Notifications ----------

/** { okunmamis: 1, sayfa, adet } → { kayitlar, toplam, okunmamis, sayfa, adet } */
export const listNotifications = (params, opts) => get(`/api/bildirimler${qs(params)}`, opts);
export const markNotificationRead = (id) => send('POST', `/api/bildirimler/${seg(id)}/okundu`);
export const markAllNotificationsRead = () => send('POST', '/api/bildirimler/hepsi-okundu');

// ---------- Mail outbox (yonetici) ----------

/** { alici? } → 202 { id } · 409 mail_kapali */
export const sendTestMail = (alici) => send('POST', '/api/eposta/deneme', alici ? { alici } : {});
/** { durum, adet } → [{ id, alici, konu, durum, deneme, sonHata, olusturma, gonderim }] */
export const listMails = (params, opts) => get(`/api/eposta${qs(params)}`, opts);
export const retryMail = (id) => send('POST', `/api/eposta/${seg(id)}/yeniden`);

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
/**
 * { ad, strateji: 'zincir'|'tek', adimlar: [{ onayciId, limit }] } → 201 Akis. Array order = approval
 * order; `limit` is the approver's inclusive approval limit (base currency), rising down the list, and
 * null for the last approver only. 400 gecersiz_akis brings `sorunlar`; 409 akis_adi_kullaniliyor.
 * Akis: { id, ad, varsayilan, strateji, paraBirimi, guncelleme, guncelleyen, kullaniciSayisi,
 * adimlar: [{ sira, onayci: { id, adSoyad, eposta, departman }, limit }] }.
 */
export const createFlow = (data) => send('POST', '/api/onay-akislari', data);
/** { ad, strateji, adimlar }: replaces the whole flow. */
export const updateFlow = (id, data) => send('PUT', `/api/onay-akislari/${seg(id)}`, data);
export const setDefaultFlow = (id) => send('POST', `/api/onay-akislari/${seg(id)}/varsayilan`);
/** 204; users assigned to the flow fall back to the default one. 409 varsayilan_akis for the default. */
export const deleteFlow = (id) => send('DELETE', `/api/onay-akislari/${seg(id)}`);
/**
 * { tutar, paraBirimi?, kur?, faturaIdler?, akisId? } → who would approve it if the signed-in user
 * sent it. faturaIdler (at most 20) lets the invoices' total raise the approval amount; akisId
 * (yonetici only) tries a saved flow other than the user's own.
 */
export const previewFlow = (data, opts) => send('POST', '/api/onay-akisi/onizle', data, opts);

// ---------- Categories ----------

/** Kategori[]: { id, ad, simge, aktif, sira, kod, kdvOranlari, hesapKodu }. `all` (yonetici) adds inactive ones. */
export const listCategories = (all, opts) => get(`/api/kategoriler${all ? '?tumu=1' : ''}`, opts);
/** { ad, simge?, kod?, kdvOranlari?, hesapKodu? } → 201 Kategori · 409 kategori_var */
export const createCategory = (data) => send('POST', '/api/kategoriler', data);
/** { ad?, simge?, aktif?, sira?, kod?, kdvOranlari?, hesapKodu? }; an empty text or null clears kod/kdvOranlari/hesapKodu. */
export const updateCategory = (id, data) => send('PATCH', `/api/kategoriler/${seg(id)}`, data);
/** 204 · 409 kullaniliyor (used on a form; make it inactive instead). */
export const deleteCategory = (id) => send('DELETE', `/api/kategoriler/${seg(id)}`);

// ---------- Definition lists (yonetici; docs section 6, "Tanım listeleri") ----------
// Every list has the same shape: GET <base>?q=&aktif=1|0&sayfa=&adet= → { kayitlar, toplam, sayfa, adet },
// POST <base>, PATCH/DELETE <base>/:id, GET <base>/disa-aktar (.xlsx) and POST <base>/ice-aktar.
// The categories list (/api/kategoriler) is not paged and answers with a plain array.

export const ORGANIZATIONS = '/api/organizasyonlar';
export const COST_CENTRES = '/api/masraf-merkezleri';
export const CATEGORIES = '/api/kategoriler';
/** The option list of a 'liste' receipt field. */
export const optionsBase = (anahtar) => `/api/alanlar/${seg(anahtar)}/secenekler`;

/** Organizasyon: { id, kod, ad, paraBirimi, aktif, kullaniciSayisi }. */
export const listOrganizations = (params, opts) => get(`${ORGANIZATIONS}${qs(params)}`, opts);
/** MasrafMerkezi: { id, kod, aciklama, gosterim, aktif, kullaniciSayisi }. */
export const listCostCentres = (params, opts) => get(`${COST_CENTRES}${qs(params)}`, opts);
/**
 * Secenek: { id, kod, ad, gosterim, aktif, sira }. Everyone may ask (only active options of an active
 * field for non-managers); 404 when the field is missing, not a 'liste' or inactive for them.
 */
export const listOptions = (anahtar, params, opts) => get(`${optionsBase(anahtar)}${qs(params)}`, opts);

/** One record of a paged definition list: create (201), change, delete (204 · 409 kullaniliyor). */
export const createDefinition = (base, data) => send('POST', base, data);
export const updateDefinition = (base, id, data) => send('PATCH', `${base}/${seg(id)}`, data);
export const deleteDefinition = (base, id) => send('DELETE', `${base}/${seg(id)}`);
export const listDefinitions = (base, params, opts) => get(`${base}${qs(params)}`, opts);

/** Every record of a list (inactive ones too) as .xlsx: { ok, blob, filename }. */
export async function exportDefinitions(base) {
  const r = await fetchBlob(`${base}/disa-aktar`);
  return r.ok ? { ...r, filename: filenameOf(r.disposition) } : r;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Sends an .xlsx file as the raw body. onizleme: nothing is written, the answer says what would
 * happen; eksikleriPasiflestir: active records whose key is not in the file become inactive.
 * → IceAktarim { onizleme, satirSayisi, eklenen, guncellenen, degismeyen, pasiflestirilen, hataSayisi,
 * hatalar: [{ satir, mesaj }], sutunlar: { alan: dosyaSutunu }, yokSayilanSutunlar } · 400 gecersiz_dosya
 * · 413 dosya_cok_buyuk.
 */
export function importDefinitions(base, file, { onizleme = false, eksikleriPasiflestir = false, signal } = {}) {
  const query = qs({ onizleme: onizleme ? 1 : undefined, eksikleriPasiflestir: eksikleriPasiflestir ? 1 : undefined });
  return call(`${base}/ice-aktar${query}`, { method: 'POST', body: file, headers: { 'Content-Type': XLSX }, signal });
}

// ---------- Receipt fields and their rules (docs section 6, "Fiş alanları") ----------

/**
 * { alanlar: AlanTanimi[], kurallar: AlanKurali[] }. Without `all` only active fields and the rules
 * whose condition field is active (targets cut to active fields); `all` (yonetici) adds inactive ones
 * and each field's `kullanim`.
 * AlanTanimi: { id, anahtar, ad, duzey: form|fis, tur, zorunlu, aktif, sira, sistem, aciklama, secenekSayisi, kullanim? }.
 * AlanKurali: { id, kosulAlan, kosulDeger: { id, gosterim, aktif }, hedefler: [anahtar] }.
 */
export const listFields = (all, opts) => get(`/api/alanlar${all ? '?tumu=1' : ''}`, opts);
/** { ad, tur, zorunlu?, aciklama? } → 201 AlanTanimi · 409 alan_adi_kullaniliyor · 409 alan_siniri */
export const createField = (data) => send('POST', '/api/alanlar', data);
/** { ad?, zorunlu?, aktif?, sira?, aciklama? } → AlanTanimi · 400 (a property this field cannot change) */
export const updateField = (id, data) => send('PATCH', `/api/alanlar/${seg(id)}`, data);
/** 204 · 409 sistem_alani · 409 alan_kullaniliyor */
export const deleteField = (id) => send('DELETE', `/api/alanlar/${seg(id)}`);
/** { kosulAlan, kosulDegerId, hedefler } → 201 AlanKurali · 409 kural_var */
export const createFieldRule = (data) => send('POST', '/api/alan-kurallari', data);
/** The whole rule: { kosulAlan, kosulDegerId, hedefler } → AlanKurali · 409 kural_var */
export const updateFieldRule = (id, data) => send('PUT', `/api/alan-kurallari/${seg(id)}`, data);
export const deleteFieldRule = (id) => send('DELETE', `/api/alan-kurallari/${seg(id)}`);

// ---------- Integrations (yonetici; docs section 9, "Entegrasyonlar") ----------

/** A 202 may come without a body; for these calls it still means "accepted". */
async function accepted(pending) {
  const r = await pending;
  return !r.ok && r.res?.status === 202 ? { ok: true, res: r.res, body: null } : r;
}

/**
 * Entegrasyon[] by name: the input's fields with defaults filled, without the password, plus
 * { id, kimlik: { tur, kullanici?, sifreVar }, sorunlar: string[], sonGonderim: { id, durum, zaman } | null,
 * olusturma, guncelleme, guncelleyen }.
 */
export const listIntegrations = (opts) => get('/api/entegrasyonlar', opts);
/** { form: Kaynak[], fis: Kaynak[] }; Kaynak: { anahtar, ad, tur: metin|sayi|tutar|tarih, aktif }. */
export const integrationSources = (opts) => get('/api/entegrasyonlar/kaynaklar', opts);
export const getIntegration = (id, opts) => get(`/api/entegrasyonlar/${seg(id)}`, opts);
/**
 * EntegrasyonGirdi: { ad, aktif, adres, yontem, bicim, kok, xmlAdAlani, fisListesi, fisOgesi, tarihBicimi,
 * tetikleyici, kimlik: { tur, kullanici?, sifre? }, basliklar: [{ ad, deger }], zamanAsimiSn,
 * alanlar: [{ kaynak, alias, deger? }] } → 201 Entegrasyon · 400 · 409 entegrasyon_adi_kullaniliyor · 409 anahtar_yok
 */
export const createIntegration = (data) => send('POST', '/api/entegrasyonlar', data);
/** The whole input replaces the integration; without kimlik.sifre the stored password is kept. */
export const updateIntegration = (id, data) => send('PUT', `/api/entegrasyonlar/${seg(id)}`, data);
/** 204; the integration's send log goes with it. */
export const deleteIntegration = (id) => send('DELETE', `/api/entegrasyonlar/${seg(id)}`);
/**
 * The body the (unsaved) input would send for a form, or for sample data without formId. Nothing is sent
 * or stored. → { govde, icerikTuru, ornek, form: { id, baslik } | null } · 400 (alanlar["entegrasyon.<yol>"]) · 404
 */
export const previewIntegration = (entegrasyon, formId, opts) =>
  send('POST', '/api/entegrasyonlar/onizle', formId === null || formId === undefined ? { entegrasyon } : { entegrasyon, formId }, opts);
/** Sends an approved or paid form by hand → 202 { id } (the send's id) · 404 · 409 gecersiz_durum */
export const sendIntegration = (id, formId) => send('POST', `/api/entegrasyonlar/${seg(id)}/gonder`, { formId });
/**
 * { entegrasyonId?, formId?, durum?: bekliyor|gonderildi|hata, adet? } → GonderimOzet[] newest first:
 * { id, entegrasyon: { id, ad }, form: { id, baslik }, tetikleyen, kullanici, durum, deneme, httpDurum,
 * sonHata, olusturma, gonderim, sonrakiDeneme }
 */
export const listIntegrationSends = (params, opts) => get(`/api/entegrasyon-gonderimleri${qs(params)}`, opts);
/** Gonderim: GonderimOzet + { govde, icerikTuru, yanit } of the last attempt (null before the first one). */
export const getIntegrationSend = (id, opts) => get(`/api/entegrasyon-gonderimleri/${seg(id)}`, opts);
/** Only a failed send (`hata`): its attempts start over and it is queued at once. 202 · 409 gecersiz_durum */
export const retryIntegrationSend = (id) => accepted(send('POST', `/api/entegrasyon-gonderimleri/${seg(id)}/yeniden`));

// ---------- Expenses ----------

/** { kapsam: 'benim'|'tumu', durum: 'onayda,taslak', q, sayfa, adet } */
export const listExpenses = (params, opts) => get(`/api/masraflar${qs(params)}`, opts);
export const getExpense = (id, opts) => get(`/api/masraflar/${seg(id)}`, opts);
/**
 * { baslik, kategoriId, masrafTarihi, tutar?, paraBirimi?, kur?, satici?, aciklama?, masrafMerkeziId?,
 * faturaIdler?, bekleyenFaturalar?, okununcaGonder?, yerelKarsiliklar?, faturaDuzeltmeleri?, fisAlanlari?,
 * gonder? } → 201 MasrafDetay. A draft may leave tutar out; bekleyenFaturalar holds the SHA-256
 * (dosyaOzeti) of files still being read. fisAlanlari maps a receipt (invoice id, or the dosyaOzeti of a
 * file still being read) to its field values ({ anahtar: deger }), replacing that receipt's values.
 */
export const createExpense = (data) => send('POST', '/api/masraflar', data);
/**
 * Only the fields that change; faturaIdler, when sent, replaces the whole invoice list (order included),
 * and bekleyenFaturalar the whole list of files still being read (always sent with faturaIdler).
 */
export const updateExpense = (id, data) => send('PATCH', `/api/masraflar/${seg(id)}`, data);

/** action: gonder | yeniden-oku | geri-cek | iptal | onayla | reddet | odendi | devret */
export const expenseAction = (id, action, body) => send('POST', `/api/masraflar/${seg(id)}/${action}`, body);

/** The approval certificate (PDF) of an approved or paid expense, as a Blob. */
export async function getExpensePdf(id, opts) {
  const r = await fetchBlob(`/api/masraflar/${seg(id)}/pdf`, opts);
  return r.ok ? { ...r, filename: filenameOf(r.disposition) } : r;
}

/** durum: bekleyen | karar */
export const listApprovals = (durum, opts) => get(`/api/onaylar${qs({ durum })}`, opts);

/** CSV of all expenses: { durum?, baslangic?, bitis? } → { ok, blob, filename }. */
export async function exportExpenses(params) {
  const r = await fetchBlob(`/api/masraflar/disa-aktar${qs(params)}`);
  return r.ok ? { ...r, filename: filenameOf(r.disposition) } : r;
}

// ---------- Invoices ----------

export const invoiceFileUrl = (id) => `/api/invoices/${seg(id)}/dosya`;

/** The original file of a record as a Blob; notFound for old records without one. */
export const getInvoiceFile = (id, opts) => fetchBlob(invoiceFileUrl(id), opts);

/**
 * One file; the request stays open until Claude has read it (or the stored result is found).
 * Aborting `signal` frees the connection and resolves with { aborted: true }; the server still
 * finishes the read and keeps the record.
 */
export async function sendOne(file, { force, tag, signal }) {
  const form = new FormData();
  form.append('file', file);
  const r = await call(force ? '/api/invoices?yenile=1' : '/api/invoices', {
    method: 'POST',
    body: form,
    headers: { 'X-Panel-Etiket': tag },
    signal,
  });
  if (!r.ok) return r;
  const id = r.res.headers.get('X-Fatura-Id');
  if (id) records.set(id, r.body);
  return { ...r, id };
}

/**
 * Several files; the server answers once each one is read from the records, refused or queued.
 * Kuyruk: { id, bitti, dosyalar: [{ sira, dosyaAdi, durum, kayitId, onbellek, hata, sonuc, dosyaOzeti,
 * kuyrukSirasi, onundeki }] }. Aborting `signal` stops the upload; files the server has already
 * taken are still read.
 */
export function sendMany(files, { force, tag, signal }) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return call(force ? '/api/invoices/toplu?yenile=1' : '/api/invoices/toplu', {
    method: 'POST',
    body: form,
    headers: { 'X-Panel-Etiket': tag },
    signal,
  });
}

/** The state of a multi-file send (same shape as sendMany's answer); 404 once the server restarted. */
export const getBatch = (id, opts) => get(`/api/invoices/toplu/${seg(id)}`, opts);

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
