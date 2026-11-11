// Entegrasyonlar (yonetici): integrations that send approved expense forms to an outside system, e.g.
// the REST or HTTP adapter of SAP PI/PO, as JSON or XML. Contract: docs/onay-sistemi.md, section 9.
//
// Addresses: #/entegrasyonlar (the list and the send log of every integration), #/entegrasyonlar/yeni
// (a new one; ?kopya=<id> starts from a copy of a saved one) and #/entegrasyonlar/<id> (edit, live
// preview, send by hand, the integration's own send log).
//
// The editor checks the contract's rules while the admin types (the name rule of aliases and of the
// root, list and item names; required fields; unique aliases per level); the server has the final word
// (400 with `alanlar`, 409). The preview posts the unsaved editor state to POST /api/entegrasyonlar/onizle.
// It never carries credentials, and a missing name or address (which do not shape the body) travels as a
// neutral stand-in so a half-filled new integration can already be previewed. The Basic password is
// write-only: it is sent only when typed and never shown.

import * as api from '../api.js';
import { statusBadge as activeBadge } from '../deflist.js';
import { el, icon, ICONS } from '../dom.js';
import { expenseHref } from '../expense-ui.js';
import { fmtCount, fmtDateTime, fmtRelative } from '../format.js';
import { INTEGRATION_FORMAT, INTEGRATION_TRIGGER, SEND_ORIGIN, SEND_STATUS, statusBadge } from '../labels.js';
import { navigate } from '../router.js';
import {
  actionDialog,
  alertBox,
  btn,
  confirmDialog,
  debounce,
  emptyState,
  field,
  fieldset,
  input,
  loadFailed,
  openDialog,
  pageHead,
  select,
  setBusy,
  setFieldError,
  setPageTitle,
  showError,
  skeletonList,
  toast,
  uid,
} from '../ui.js';
import { passwordField } from './login.js';

const ROUTE = '/entegrasyonlar';
const NAME_MAX = 80;
const ALIAS_MAX = 60;
const MAX_ROWS = 100;
const MAX_HEADERS = 20;
const LOG_LIMIT = 50;
const PREVIEW_DELAY = 400;
const POLL_EVERY = 1500;
const POLL_FOR = 45_000;
const PREVIEW_ADDRESS = 'https://ornek.invalid/'; // stands in for an address not typed yet; not part of the body

const BLANK = {
  ad: '',
  aktif: true,
  adres: '',
  yontem: 'POST',
  bicim: 'json',
  kok: null,
  xmlAdAlani: null,
  fisListesi: 'FISLER',
  fisOgesi: 'FIS',
  tarihBicimi: 'YYYY-AA-GG',
  tetikleyici: 'onaylandi',
  kimlik: { tur: 'yok' },
  basliklar: [],
  zamanAsimiSn: 30,
  alanlar: [],
};

const DATE_FORMATS = [
  { value: 'YYYY-AA-GG', label: 'YYYY-AA-GG · 2026-11-05' },
  { value: 'YYYYAAGG', label: 'YYYYAAGG · 20261105 (SAP DATS)' },
  { value: 'GG.AA.YYYY', label: 'GG.AA.YYYY · 05.11.2026' },
];

const TRIGGER_HINT = {
  onaylandi: 'Form son onayı alınca kendiliğinden gönderilir.',
  odendi: 'Muhasebe formu ödendi işaretleyince kendiliğinden gönderilir.',
  elle: 'Kendiliğinden gönderilmez; yalnızca bu sayfadan elle gönderilir.',
};

const TYPE_LABEL = { metin: 'Metin', sayi: 'Sayı', tutar: 'Tutar', tarih: 'Tarih' };

const LOG_FILTERS = [
  { value: 'hata', label: 'Hatalı' },
  { value: 'bekliyor', label: 'Bekleyen' },
  { value: 'gonderildi', label: 'Gönderilen' },
  { value: '', label: 'Tümü' },
];

const KEY_LABEL = {
  ad: 'Ad',
  aktif: 'Durum',
  adres: 'Adres',
  yontem: 'Yöntem',
  zamanAsimiSn: 'Zaman aşımı',
  bicim: 'Biçim',
  kok: 'Kök adı',
  xmlAdAlani: 'XML ad alanı',
  fisListesi: 'Fiş listesi adı',
  fisOgesi: 'Fiş öğesi adı',
  tarihBicimi: 'Tarih biçimi',
  tetikleyici: 'Gönderim zamanı',
  'kimlik.tur': 'Kimlik doğrulama',
  'kimlik.kullanici': 'Kullanıcı adı',
  'kimlik.sifre': 'Şifre',
  basliklar: 'Ek başlıklar',
  alanlar: 'Alan eşlemesi',
  formId: 'Form no',
};

// The order the editor shows its simple controls in (errors are listed and focused in this order).
const SIMPLE_KEYS = ['ad', 'adres', 'yontem', 'zamanAsimiSn', 'bicim', 'kok', 'xmlAdAlani', 'fisListesi', 'fisOgesi', 'tarihBicimi', 'alanlar', 'tetikleyici', 'kimlik.tur', 'kimlik.kullanici', 'kimlik.sifre', 'basliklar'];

// Named in the contract; the server refuses the other connection headers as well.
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'authorization', 'connection', 'transfer-encoding', 'cookie']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NAME_CHARS = /^[A-Za-z0-9_.-]+$/;
const TR_ASCII = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };

let keySeq = 0;
const newKey = () => `k${++keySeq}`;
const quoted = (s) => `“${s}”`;
const arr = (v) => (Array.isArray(v) ? v : []);
const levelOf = (kaynak) => (String(kaynak ?? '').startsWith('fis.') ? 'fis' : 'form');
const isConst = (kaynak) => kaynak === 'form.sabit' || kaynak === 'fis.sabit';
const integrationHref = (id) => `#${ROUTE}/${encodeURIComponent(String(id))}`;

/** replaceChildren that skips null and false (the native one would write "null"). */
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false && k !== ''));
}

// ---------- Rules the editor checks as the admin types (the server decides) ----------

/** The contract's name rule (alias, kök, fiş listesi, fiş öğesi); null when the name is fine. */
function nameProblem(value, empty = 'Bir ad girin.') {
  if (!value) return empty;
  if (value.length > ALIAS_MAX) return `En çok ${ALIAS_MAX} karakter olabilir.`;
  if (/\s/.test(value)) return 'Boşluk kullanılamaz; yerine _ yazabilirsiniz.';
  if (/[^\x20-\x7e]/.test(value)) return 'Türkçe harf ve özel karakter kullanılamaz (ör. Ş yerine S, ı yerine i).';
  if (!/^[A-Za-z_]/.test(value)) return 'Harf ya da _ ile başlamalı.';
  if (!NAME_CHARS.test(value)) return 'Yalnızca harf, rakam, _, - ve . kullanılabilir.';
  if (/^xml/i.test(value)) return '“xml” ile başlayamaz.';
  return null;
}

function addressProblem(value) {
  if (!value) return 'Gönderilecek adresi girin.';
  if (!/^https?:\/\//i.test(value)) return 'Adres http:// ya da https:// ile başlamalı.';
  if (value.length > 2000) return 'En çok 2000 karakter olabilir.';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Geçerli bir adres girin.';
  }
  if (url.username || url.password) return 'Adreste kullanıcı adı ya da şifre olamaz; Basic kimlik doğrulamasını kullanın.';
  return null;
}

const validTimeout = (v) => Number.isInteger(v) && v >= 5 && v <= 120;

/** { ad?, deger? } messages of one extra header row, or null. */
function headerProblem(h) {
  const name = h.ad.trim();
  const p = {};
  if (!name) p.ad = 'Başlığın adını girin.';
  else if (!HEADER_NAME.test(name)) p.ad = 'Geçerli bir başlık adı girin: harf, rakam ve - gibi işaretler; boşluk ve Türkçe harf olmaz.';
  else if (name.toLowerCase() === 'authorization') p.ad = 'Authorization eklenemez; Basic kimlik doğrulamasını kullanın.';
  else if (BLOCKED_HEADERS.has(name.toLowerCase())) p.ad = `${name} başlığı eklenemez.`;
  if (h.deger.trim().length > 1000) p.deger = 'En çok 1000 karakter olabilir.';
  else if (/[\r\n]/.test(h.deger)) p.deger = 'Satır sonu içeremez.';
  return p.ad || p.deger ? p : null;
}

const headerUsed = (h) => Boolean(h.ad.trim() || h.deger.trim());

/** A default alias from a source key: form.masrafMerkeziAciklama → MASRAF_MERKEZI_ACIKLAMA. */
function aliasFor(kaynak) {
  let base = String(kaynak)
    .replace(/^(form|fis)\.(alan\.)?/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => TR_ASCII[c] ?? '_')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .toUpperCase();
  if (!/^[A-Z_]/.test(base)) base = `_${base}`;
  if (/^XML/.test(base)) base = `_${base}`;
  return base.slice(0, ALIAS_MAX) || 'ALAN';
}

/** base, or base_2, base_3 … when the name is taken (taken: lower-case names). */
function uniqueAlias(base, taken) {
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = `_${n}`;
    name = `${base.slice(0, ALIAS_MAX - suffix.length)}${suffix}`;
  }
  return name;
}

/** The source list of a level, with the constant source even if the server left it out. */
function normalizeSources(body) {
  const out = {};
  for (const level of ['form', 'fis']) {
    const list = arr(body?.[level]).filter((s) => s && typeof s.anahtar === 'string');
    if (!list.some((s) => s.anahtar === `${level}.sabit`)) list.push({ anahtar: `${level}.sabit`, ad: 'Sabit değer', tur: 'metin', aktif: true });
    out[level] = list;
  }
  return out;
}

/** The sources of a level in the groups the pickers show. */
function sourceGroups(sources, level) {
  const list = sources[level] ?? [];
  const constant = (s) => isConst(s.anahtar);
  const own = (s) => s.anahtar.startsWith('fis.alan.');
  const groups =
    level === 'form'
      ? [
          { title: 'Form bilgileri', items: list.filter((s) => !constant(s)) },
          { title: 'Sabit', items: list.filter(constant) },
        ]
      : [
          { title: 'Fatura bilgileri', items: list.filter((s) => !constant(s) && !own(s)) },
          { title: 'Fiş alanları', items: list.filter(own) },
          { title: 'Sabit', items: list.filter(constant) },
        ];
  return groups.filter((g) => g.items.length > 0);
}

// ---------- Bodies: light syntax colours, copying ----------

function kindOf(contentType, text) {
  if (/json/i.test(contentType ?? '')) return 'json';
  if (/xml/i.test(contentType ?? '')) return 'xml';
  const c = String(text ?? '').trimStart()[0];
  return c === '{' || c === '[' ? 'json' : c === '<' ? 'xml' : 'text';
}

/** A JSON answer on one line is indented for reading; anything else stays as it came. */
function readable(text, kind) {
  if (kind !== 'json' || text.includes('\n')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text; // the first 2000 characters of a longer answer
  }
}

/** The body as text nodes and spans (keys, strings, numbers, tags); never HTML. */
function highlighted(text, kind) {
  if (!text) return [];
  if (text.length > 200_000 || (kind !== 'json' && kind !== 'xml')) return [text];
  const out = [];
  const push = (s, cls = null) => {
    if (s) out.push(cls ? el('span', { className: cls, text: s }) : s);
  };
  if (kind === 'json') {
    let last = 0;
    for (const m of text.matchAll(/("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
      push(text.slice(last, m.index));
      if (m[1]) {
        push(m[1], m[2] ? 'k' : 's');
        push(m[2]);
      } else {
        push(m[0], /^[tfn]/.test(m[0]) ? 'z' : 'n');
      }
      last = m.index + m[0].length;
    }
    push(text.slice(last));
    return out;
  }
  for (const part of text.split(/(<[^>]*>)/)) {
    if (!part) continue;
    if (!part.startsWith('<')) {
      push(part, part.trim() ? 's' : null);
      continue;
    }
    if (part.startsWith('<?') || part.startsWith('<!')) {
      push(part, 'z');
      continue;
    }
    const m = /^(<\/?)([^\s/>]+)([\s\S]*?)(\/?>)$/.exec(part);
    if (!m) {
      push(part, 'k');
      continue;
    }
    push(m[1], 'z');
    push(m[2], 'k');
    let i = 0;
    for (const a of m[3].matchAll(/"[^"]*"/g)) {
      push(m[3].slice(i, a.index));
      push(a[0], 's');
      i = a.index + a[0].length;
    }
    push(m[3].slice(i));
    push(m[4], 'z');
  }
  return out;
}

async function copyText(text, node, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} panoya kopyalandı.`, 'ok');
  } catch {
    // No clipboard outside a secure context (e.g. a phone on the local network over http): select it.
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    toast('Panoya kopyalanamadı; metin seçildi, Ctrl+C ile kopyalayabilirsiniz.', 'err');
  }
}

/** A titled, scrollable, copyable code block; emptyText when there is nothing to show. */
function codeSection(title, text, contentType, emptyText, note = null) {
  const headId = uid('ig-code');
  const head = el('h3', { className: 'sec-title', id: headId, text: title });
  if (!text) return el('section', { className: 'ig-code-sec', 'aria-labelledby': headId }, head, el('p', { className: 'muted small', text: emptyText }));
  const kind = kindOf(contentType, text);
  const pre = el('pre', { className: 'json ig-code', tabindex: '0', 'aria-labelledby': headId }, ...highlighted(readable(text, kind), kind));
  return el(
    'section',
    { className: 'ig-code-sec', 'aria-labelledby': headId },
    el(
      'div',
      { className: 'ig-code-head' },
      head,
      contentType ? el('span', { className: 'tag mono ig-ctype', text: contentType }) : null,
      btn('Kopyala', { icon: ICONS.copy, size: 'sm', onClick: () => copyText(text, pre, title), attrs: { 'aria-label': `${title}: kopyala` } }),
    ),
    pre,
    note ? el('p', { className: 'hint', text: note }) : null,
  );
}

// ---------- Send log pieces ----------

const timeCell = (iso) => (iso ? el('time', { datetime: iso, title: fmtDateTime(iso), text: fmtRelative(iso) ?? '' }) : el('span', { className: 'muted', text: '—' }));

function originText(g) {
  const label = SEND_ORIGIN[g.tetikleyen] ?? g.tetikleyen ?? '—';
  return g.kullanici?.adSoyad ? `${label} · ${g.kullanici.adSoyad}` : label;
}

function formCell(form) {
  if (!form) return el('span', { className: 'muted', text: '—' });
  return el(
    'a',
    { className: 'ig-form-link', href: expenseHref(form.id), 'aria-label': form.baslik ? `Masraf #${form.id}: ${form.baslik}` : `Masraf #${form.id}` },
    el('span', { className: 'mono', text: `#${form.id}` }),
    form.baslik ? el('span', { className: 'cell-sub', text: form.baslik }) : null,
  );
}

/** The detail of one send (GET /api/entegrasyon-gonderimleri/:id): what was sent and what came back. */
function openSendDetail(sendId, { onChange } = {}) {
  const body = el('div', { className: 'ig-detail', 'aria-live': 'polite' }, el('div', { className: 'form-skeleton small', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span')));
  const ctl = openDialog({ title: `Gönderim #${sendId}`, size: 'wide', body: [body] });
  const ac = new AbortController();
  ctl.done.then(() => ac.abort());

  async function retry(button) {
    setBusy(button, true);
    const r = await api.retryIntegrationSend(sendId);
    if (ac.signal.aborted) return;
    setBusy(button, false);
    if (!r.ok) {
      showError(r);
      return;
    }
    toast('Gönderim yeniden denenmek üzere kuyruğa alındı.', 'ok');
    onChange?.();
    ctl.close(null);
  }

  function render(g) {
    const tried = (g.deneme ?? 0) > 0;
    const facts = [
      ['Entegrasyon', g.entegrasyon ? el('a', { href: integrationHref(g.entegrasyon.id), text: g.entegrasyon.ad }) : '—'],
      ['Form', formCell(g.form)],
      ['Tetikleyen', originText(g)],
      ['Deneme', fmtCount(g.deneme ?? 0)],
      ['HTTP durumu', g.httpDurum ? String(g.httpDurum) : tried ? 'Yanıt alınamadı' : '—'],
      ['Oluşturma', fmtDateTime(g.olusturma) ?? '—'],
      ['Son deneme', fmtDateTime(g.gonderim) ?? '—'],
      g.sonrakiDeneme ? ['Sonraki deneme', fmtDateTime(g.sonrakiDeneme)] : null,
    ].filter(Boolean);
    const retryBtn = g.durum === 'hata' ? btn('Yeniden dene', { icon: ICONS.refresh, kind: 'primary', size: 'sm', onClick: (e) => retry(e.currentTarget) }) : null;
    fill(
      body,
      el('div', { className: 'ig-detail-head' }, statusBadge(g.durum, { map: SEND_STATUS }), retryBtn),
      g.sonHata ? alertBox(g.durum === 'hata' ? 'err' : 'warn', 'Son hata', [g.sonHata]) : null,
      el('dl', { className: 'kv ig-kv' }, ...facts.map(([t, d]) => el('div', {}, el('dt', { text: t }), el('dd', {}, d)))),
      codeSection('Gönderilen gövde', g.govde, g.icerikTuru, 'Henüz denenmedi; gövde gönderim anında, formun o anki bilgisiyle hazırlanır.'),
      codeSection('Yanıt', g.yanit, null, tried ? 'Yanıt gövdesi yok.' : 'Henüz yanıt yok.', 'Yanıtın ilk 2000 karakteri saklanır.'),
    );
  }

  (async () => {
    const r = await api.getIntegrationSend(sendId, { signal: ac.signal });
    if (ac.signal.aborted) return;
    if (!r.ok) {
      if (!r.unauthorized) fill(body, alertBox('err', null, [r.error.mesaj]));
      return;
    }
    render(r.body);
  })();
}

/**
 * The send log (GET /api/entegrasyon-gonderimleri), newest first, with a status filter. Without
 * integrationId it also filters by integration (setIntegrations fills that list).
 * Returns { node, load, setIntegrations, stop }.
 */
function sendLog({ signal, integrationId = null, status = 'hata' }) {
  const fixed = integrationId !== null;
  let durum = status;
  let target = fixed ? String(integrationId) : '';
  let token = 0;
  let later = null;
  let stopped = false;
  const headId = uid('ig-log');
  const statusSel = select(LOG_FILTERS, { className: 'input input-sm', 'aria-label': 'Duruma göre süz' });
  statusSel.value = durum;
  const intSel = fixed ? null : select([{ value: '', label: 'Bütün entegrasyonlar' }], { className: 'input input-sm', 'aria-label': 'Entegrasyona göre süz' });
  const list = el('div', { className: 'ig-log' }, skeletonList(3));
  const node = el(
    'section',
    { className: 'card ig-log-card', 'aria-labelledby': headId },
    el(
      'div',
      { className: 'card-head' },
      el(
        'div',
        { className: 'card-head-text' },
        el('h2', { className: 'card-title', id: headId, text: 'Gönderim kaydı' }),
        el('p', { className: 'card-sub', text: fixed ? 'Bu entegrasyonun gönderimleri, en yenisi önce.' : 'Bütün entegrasyonların gönderimleri, en yenisi önce.' }),
      ),
      el('div', { className: 'ig-log-tools' }, intSel, statusSel, btn('Yenile', { icon: ICONS.refresh, size: 'sm', onClick: () => load() })),
    ),
    list,
  );

  statusSel.addEventListener('change', () => {
    durum = statusSel.value;
    load();
  });
  intSel?.addEventListener('change', () => {
    target = intSel.value;
    load();
  });

  function setIntegrations(items) {
    if (!intSel) return;
    const keep = intSel.value;
    fill(intSel, el('option', { value: '', text: 'Bütün entegrasyonlar' }), ...items.map((it) => el('option', { value: String(it.id), text: it.ad })));
    intSel.value = items.some((it) => String(it.id) === keep) ? keep : '';
    if (intSel.value !== target) {
      target = intSel.value;
      load();
    }
  }

  async function load() {
    if (stopped) return;
    clearTimeout(later);
    const my = ++token;
    list.setAttribute('aria-busy', 'true');
    const r = await api.listIntegrationSends({ entegrasyonId: target || undefined, durum: durum || undefined, adet: LOG_LIMIT }, { signal });
    if (stopped || my !== token) return;
    list.removeAttribute('aria-busy');
    if (!r.ok) {
      if (!r.unauthorized && !r.aborted) fill(list, loadFailed(r, load));
      return;
    }
    render(arr(r.body));
  }

  /** After a retry: now, and once more a moment later when the attempt has likely finished. */
  function reloadSoon() {
    load();
    later = setTimeout(load, 3000);
  }

  function emptyFor() {
    const texts = {
      hata: ['Hatalı gönderim yok', 'Gönderilemeyen bir kayıt bulunmuyor.'],
      bekliyor: ['Bekleyen gönderim yok', 'Kuyrukta bekleyen bir gönderim bulunmuyor.'],
      gonderildi: ['Gönderilmiş kayıt yok', 'Başarıyla gönderilmiş bir kayıt bulunmuyor.'],
      '': ['Henüz gönderim yok', fixed ? 'Bu entegrasyonla yapılan gönderimler burada görünür.' : 'Entegrasyonların gönderimleri burada görünür.'],
    };
    const [title, text] = texts[durum] ?? texts[''];
    const all = durum
      ? btn('Tümünü göster', {
          size: 'sm',
          onClick: () => {
            durum = '';
            statusSel.value = '';
            load();
          },
        })
      : null;
    return emptyState({ icon: ICONS.send, title, text, action: all });
  }

  function render(rows) {
    if (rows.length === 0) {
      fill(list, emptyFor());
      return;
    }
    const heads = [
      { label: 'Zaman' },
      fixed ? null : { label: 'Entegrasyon' },
      { label: 'Form' },
      { label: 'Tetikleyen' },
      { label: 'Durum' },
      { label: 'Deneme', className: 'num' },
      { label: 'HTTP', className: 'num' },
      { label: 'Son hata' },
      { label: 'İşlemler', hidden: true },
    ].filter(Boolean);
    const body = rows.map((g) =>
      el(
        'tr',
        { 'data-id': g.id },
        el('td', { className: 't-date', 'data-label': 'Zaman' }, timeCell(g.gonderim ?? g.olusturma)),
        fixed ? null : el('td', { 'data-label': 'Entegrasyon' }, g.entegrasyon ? el('a', { className: 'ig-int-link', href: integrationHref(g.entegrasyon.id), text: g.entegrasyon.ad }) : el('span', { className: 'muted', text: '—' })),
        el('td', { 'data-label': 'Form' }, formCell(g.form)),
        el('td', { 'data-label': 'Tetikleyen', text: originText(g) }),
        el(
          'td',
          { 'data-label': 'Durum' },
          statusBadge(g.durum, { map: SEND_STATUS, className: 'sm' }),
          g.durum === 'bekliyor' && g.sonrakiDeneme ? el('span', { className: 'ig-next', text: `Sonraki deneme ${fmtDateTime(g.sonrakiDeneme)}` }) : null,
        ),
        el('td', { className: 'num', 'data-label': 'Deneme', text: fmtCount(g.deneme ?? 0) }),
        el('td', { className: 'num', 'data-label': 'HTTP', text: g.httpDurum ? String(g.httpDurum) : '—' }),
        el('td', { className: 't-detail', 'data-label': 'Son hata' }, g.sonHata ? el('span', { className: 'ig-err', title: g.sonHata, text: g.sonHata }) : el('span', { className: 'muted', text: '—' })),
        el(
          'td',
          { className: 't-actions' },
          btn('Ayrıntı', { icon: ICONS.eye, size: 'sm', iconOnly: true, onClick: () => openSendDetail(g.id, { onChange: reloadSoon }), attrs: { 'aria-label': `Gönderim #${g.id}: ayrıntı` } }),
          g.durum === 'hata' ? btn('Yeniden dene', { icon: ICONS.refresh, size: 'sm', onClick: (e) => retry(g, e.currentTarget), attrs: { 'aria-label': `Gönderim #${g.id}: yeniden dene` } }) : null,
        ),
      ),
    );
    fill(
      list,
      el(
        'div',
        { className: 'table-scroll' },
        el(
          'table',
          { className: 'data-table ig-log-table' },
          el('caption', { className: 'visually-hidden', text: 'Gönderim kaydı' }),
          el('thead', {}, el('tr', {}, ...heads.map((h) => (h.hidden ? el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: h.label })) : el('th', { scope: 'col', className: h.className ?? null, text: h.label }))))),
          el('tbody', {}, ...body),
        ),
      ),
      rows.length >= LOG_LIMIT ? el('p', { className: 'muted small ig-log-note', text: `En yeni ${LOG_LIMIT} gönderim gösteriliyor.` }) : null,
    );
  }

  async function retry(g, button) {
    setBusy(button, true);
    const r = await api.retryIntegrationSend(g.id);
    if (stopped) return;
    if (!r.ok) {
      setBusy(button, false);
      showError(r);
      if (r.error?.durum === 409 || r.error?.durum === 404) load();
      return;
    }
    toast('Gönderim yeniden denenmek üzere kuyruğa alındı.', 'ok');
    reloadSoon();
  }

  function stop() {
    stopped = true;
    clearTimeout(later);
  }

  return { node, load, setIntegrations, stop };
}

// ---------- #/entegrasyonlar: the list and the send log ----------

export const integrationsView = {
  mount(root, { signal }) {
    let alive = true;
    const newHref = `#${ROUTE}/yeni`;
    const listSlot = el('div', { className: 'ig-list' }, skeletonList(3));
    const countSub = el('p', { className: 'card-sub' });
    const log = sendLog({ signal, status: 'hata' });

    root.append(
      el(
        'div',
        { className: 'page' },
        pageHead({
          title: 'Entegrasyonlar',
          sub: 'Onaylanan masraf formlarını SAP PI/PO gibi dış sistemlere, seçtiğiniz alanlar ve adlarla JSON ya da XML olarak gönderir.',
          actions: [btn('Yeni entegrasyon', { icon: ICONS.plus, kind: 'primary', href: newHref })],
        }),
        el(
          'div',
          { className: 'ig-stack' },
          el(
            'section',
            { className: 'card', 'aria-labelledby': 'ig-list-h' },
            el('div', { className: 'card-head' }, el('div', { className: 'card-head-text' }, el('h2', { className: 'card-title', id: 'ig-list-h', text: 'Tanımlı entegrasyonlar' }), countSub)),
            listSlot,
          ),
          log.node,
        ),
      ),
    );

    function lastSend(s) {
      if (!s) return el('span', { className: 'muted', text: 'Henüz yok' });
      return el(
        'span',
        { className: 'ig-last' },
        statusBadge(s.durum, { map: SEND_STATUS, className: 'sm' }),
        timeCell(s.zaman),
        btn('Ayrıntı', { icon: ICONS.eye, size: 'sm', iconOnly: true, kind: 'ghost', onClick: () => openSendDetail(s.id, { onChange: () => load() }), attrs: { 'aria-label': `Son gönderim #${s.id}: ayrıntı` } }),
      );
    }

    function issues(list) {
      if (!list.length) return null;
      return el(
        'div',
        { className: 'ig-issues' },
        icon(ICONS.warn),
        el('div', {}, el('p', { text: `${fmtCount(list.length)} sorun: düzeltilene kadar gönderimler hata olur.` }), el('ul', {}, ...list.map((t) => el('li', { text: t })))),
      );
    }

    function render(items) {
      countSub.textContent = items.length ? `${fmtCount(items.length)} entegrasyon, ${fmtCount(items.filter((i) => i.aktif).length)} aktif.` : '';
      if (items.length === 0) {
        fill(
          listSlot,
          emptyState({
            icon: ICONS.plug,
            title: 'Henüz entegrasyon yok',
            text: 'Onaylanan masrafları SAP PI/PO’ya ya da başka bir sisteme göndermek için bir entegrasyon tanımlayın: adres, gövde biçimi ve hangi alanın hangi adla gideceği.',
            action: btn('Yeni entegrasyon', { icon: ICONS.plus, kind: 'primary', href: newHref }),
          }),
        );
        return;
      }
      const rows = items.map((it) =>
        el(
          'tr',
          { className: it.aktif ? null : 'is-off' },
          el(
            'td',
            { className: 't-main', 'data-label': 'Entegrasyon' },
            el('div', { className: 'cell-text' }, el('a', { className: 'ig-name', href: integrationHref(it.id), text: it.ad }), issues(arr(it.sorunlar))),
          ),
          el('td', { 'data-label': 'Durum' }, activeBadge(it.aktif)),
          el('td', { 'data-label': 'Biçim' }, el('span', { className: 'tag', text: INTEGRATION_FORMAT[it.bicim] ?? it.bicim })),
          el('td', { 'data-label': 'Gönderim zamanı', text: INTEGRATION_TRIGGER[it.tetikleyici] ?? it.tetikleyici }),
          el('td', { className: 't-detail', 'data-label': 'Adres' }, el('span', { className: 'ig-url', title: it.adres }, el('span', { className: 'ig-method', text: it.yontem }), el('span', { className: 'mono', text: it.adres }))),
          el('td', { 'data-label': 'Son gönderim' }, lastSend(it.sonGonderim)),
          el('td', { className: 't-actions' }, btn('Düzenle', { icon: ICONS.edit, size: 'sm', iconOnly: true, href: integrationHref(it.id), attrs: { 'aria-label': `${it.ad}: düzenle` } })),
        ),
      );
      fill(
        listSlot,
        el(
          'div',
          { className: 'table-scroll' },
          el(
            'table',
            { className: 'data-table ig-table' },
            el('caption', { className: 'visually-hidden', text: 'Tanımlı entegrasyonlar' }),
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                ...['Entegrasyon', 'Durum', 'Biçim', 'Gönderim zamanı', 'Adres', 'Son gönderim'].map((h) => el('th', { scope: 'col', text: h })),
                el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'İşlemler' })),
              ),
            ),
            el('tbody', {}, ...rows),
          ),
        ),
      );
    }

    async function load() {
      const r = await api.listIntegrations({ signal });
      if (!alive) return;
      if (!r.ok) {
        if (!r.unauthorized && !r.aborted) fill(listSlot, loadFailed(r, load));
        return;
      }
      const items = arr(r.body);
      log.setIntegrations(items);
      render(items);
    }

    load();
    log.load();
    return {
      unmount() {
        alive = false;
        log.stop();
      },
    };
  },
};

// ---------- #/entegrasyonlar/yeni and #/entegrasyonlar/<id>: the editor ----------

/** A two-or-three way choice as radios that look like a segmented control (arrow keys move). */
function segRadio(name, options) {
  const group = uid(name);
  const inputs = {};
  const node = el(
    'div',
    { className: 'seg-radio' },
    ...options.map(([value, label]) => {
      inputs[value] = el('input', { type: 'radio', name: group, value });
      return el('label', { className: 'seg-opt' }, inputs[value], el('span', { text: label }));
    }),
  );
  return {
    node,
    inputs,
    get value() {
      return Object.values(inputs).find((i) => i.checked)?.value ?? options[0][0];
    },
    set(value) {
      (inputs[value] ?? inputs[options[0][0]]).checked = true;
    },
  };
}

/** An inline message under a control that is not inside a ui.field (rows); null clears it. */
function slotError(control, slot, message) {
  if (!slot) return;
  if (message) {
    control?.setAttribute('aria-invalid', 'true');
    fill(slot, icon(ICONS.alert), el('span', { text: message }));
    slot.hidden = false;
  } else {
    control?.removeAttribute('aria-invalid');
    slot.replaceChildren();
    slot.hidden = true;
  }
}

export const integrationEditView = {
  mount(root, { route, signal }) {
    const creating = route.name === 'entegrasyon-yeni';
    let id = creating ? null : Number(route.params.id);
    let saved = null; // the Entegrasyon as the server last returned it
    let sources = { form: [], fis: [] };
    let loaded = false;
    let alive = true;
    let saving = false;
    let sending = false;
    let attempted = false; // a save was tried: every problem shows, not only the touched ones
    let leaveOk = false;
    let savedSig = '';
    let formRows = []; // [{ key, kaynak, alias, deger, autoAlias }] in body order
    let fisRows = [];
    let headers = []; // [{ key, ad, deger }]
    let log = null;
    let previewCtl = null;
    let previewSig = null;
    let lastBody = '';
    let pollToken = 0;
    let pollTimer = null;
    const touched = new Set(); // error keys the admin has changed
    const serverErr = new Map(); // error key → message of the last save
    const previewErr = new Map(); // error key → message of the last preview
    const rowRefs = new Map(); // row key → controls
    const hdrRefs = new Map(); // header key → controls
    const shown = new WeakMap(); // control or slot → the message on screen

    const rowsOf = (level) => (level === 'form' ? formRows : fisRows);
    const sourceOf = (level, key) => sources[level]?.find((s) => s.anahtar === key) ?? null;
    const sourceName = (level, key) => sourceOf(level, key)?.ad ?? key;
    const storedPassword = () => saved?.kimlik?.tur === 'basic' && saved.kimlik.sifreVar === true;

    // ---------- Page frame ----------

    const subEl = el('p', { className: 'page-sub' });
    const copyBtn = btn('Kopyasını oluştur', { icon: ICONS.copy, href: `#${ROUTE}`, attrs: { hidden: true } });
    const deleteBtn = btn('Sil', { icon: ICONS.trash, kind: 'danger-ghost', onClick: removeIntegration, attrs: { hidden: true } });
    const head = pageHead({ back: { href: `#${ROUTE}`, label: 'Entegrasyonlar' }, title: creating ? 'Yeni entegrasyon' : 'Entegrasyon', sub: subEl, actions: [copyBtn, deleteBtn] });
    const titleEl = head.querySelector('h1');
    const announcer = el('p', { className: 'visually-hidden', role: 'status' });
    const issuesSlot = el('div', { className: 'form-alert' });
    const alertSlot = el('div', { className: 'form-alert', tabindex: '-1' });
    const contentSlot = el('div', {}, el('div', { className: 'form-skeleton', role: 'status', 'aria-label': 'Yükleniyor' }, el('span'), el('span'), el('span')));
    const logSlot = el('div', { className: 'ig-log-slot' });
    root.append(el('div', { className: 'page wide' }, head, announcer, issuesSlot, alertSlot, contentSlot, logSlot));

    const announce = (text) => {
      announcer.textContent = text;
    };

    // ---------- General ----------

    const nameIn = input({ name: 'ad', maxlength: NAME_MAX, autocomplete: 'off', spellcheck: 'false', placeholder: 'Örn. SAP PI masraf (canlı)' });
    const activeSw = el('button', { className: 'switch', type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-label': 'Entegrasyon aktif', 'aria-describedby': 'ig-active-hint' }, el('span', { className: 'switch-knob', 'aria-hidden': 'true' }));
    const activeText = el('span', { className: 'switch-text', 'aria-hidden': 'true', text: 'Aktif' });
    const methodSel = select(
      [
        { value: 'POST', label: 'POST' },
        { value: 'PUT', label: 'PUT' },
      ],
      { name: 'yontem' },
    );
    const addrIn = input({ name: 'adres', type: 'url', inputmode: 'url', maxlength: 2000, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', className: 'input mono', placeholder: 'https://pi.firma.local:50001/RESTAdapter/masraf' });
    const timeoutIn = input({ name: 'zamanAsimiSn', type: 'number', inputmode: 'numeric', min: 5, max: 120, step: 1, className: 'input num' });
    const isActive = () => activeSw.getAttribute('aria-checked') === 'true';
    function setActive(on) {
      activeSw.setAttribute('aria-checked', String(on));
      activeText.textContent = on ? 'Aktif' : 'Pasif';
    }
    activeSw.addEventListener('click', () => {
      setActive(!isActive());
      changed();
    });

    // ---------- Body format ----------

    const formatRadios = segRadio('bicim', [
      ['json', 'JSON'],
      ['xml', 'XML'],
    ]);
    const formatSet = fieldset({ legend: 'Biçim', content: formatRadios.node, className: 'ig-seg-field' });
    const nameProps = { autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', className: 'input mono' };
    const kokIn = input({ name: 'kok', maxlength: ALIAS_MAX, ...nameProps });
    const kokHint = el('span');
    const kokField = field({ label: 'Kök adı', input: kokIn, hint: kokHint, optional: true });
    const nsIn = input({ name: 'xmlAdAlani', maxlength: 400, ...nameProps, placeholder: 'urn:firma:masraf' });
    const nsField = field({ label: 'XML ad alanı', input: nsIn, optional: true, hint: 'Doluysa kök ns0: önekiyle yazılır. Alt öğeler ad alanı almaz.' });
    const listIn = input({ name: 'fisListesi', maxlength: ALIAS_MAX, ...nameProps, placeholder: 'FISLER' });
    const listField = field({ label: 'Fiş listesi adı', input: listIn, hint: 'Fiş düzeyindeki alanlar bu adla liste olarak yazılır; fiş alanı eşlenmemişse liste yazılmaz.' });
    const itemIn = input({ name: 'fisOgesi', maxlength: ALIAS_MAX, ...nameProps, placeholder: 'FIS' });
    const itemField = field({ label: 'Fiş öğesi adı', input: itemIn, hint: 'XML listesindeki her fişin öğe adı.' });
    const dateSel = select(DATE_FORMATS, { name: 'tarihBicimi' });
    const dateField = field({ label: 'Tarih biçimi', input: dateSel, hint: 'Tarih türündeki alanlar böyle yazılır. Gönderim, onay ve ödeme zamanları sunucunun yerel tarihine çevrilir.' });

    function applyFormat() {
      const xml = formatRadios.value === 'xml';
      nsField.hidden = !xml;
      itemField.hidden = !xml;
      const optionalMark = kokField.querySelector('.optional');
      if (optionalMark) optionalMark.hidden = xml;
      kokHint.textContent = xml ? 'XML’de zorunlu: kök öğenin adı, ör. MT_Masraf.' : 'Doluysa gövde bu adla sarılır, ör. { "MASRAF": { … } }. Boş bırakılabilir.';
      kokIn.placeholder = xml ? 'MT_Masraf' : 'Boş: sarılmaz';
    }

    // ---------- Trigger ----------

    const triggerName = uid('tetik');
    const triggerInputs = {};
    const triggerCards = Object.entries(INTEGRATION_TRIGGER).map(([value, label]) => {
      triggerInputs[value] = el('input', { type: 'radio', name: triggerName, value, 'aria-describedby': `ig-trig-${value}` });
      return el(
        'label',
        { className: 'role-option' },
        triggerInputs[value],
        el('span', { className: 'role-text' }, el('span', { className: 'role-title', text: label }), el('span', { className: 'role-hint', id: `ig-trig-${value}`, text: TRIGGER_HINT[value] })),
      );
    });
    const triggerSet = fieldset({ legend: 'Ne zaman gönderilsin?', content: el('div', { className: 'role-options ig-triggers' }, ...triggerCards), className: 'ig-trigger-field' });
    const triggerValue = () => Object.values(triggerInputs).find((i) => i.checked)?.value ?? BLANK.tetikleyici;
    const setTrigger = (value) => {
      (triggerInputs[value] ?? triggerInputs[BLANK.tetikleyici]).checked = true;
    };

    // ---------- Authentication ----------

    const authRadios = segRadio('kimlik', [
      ['yok', 'Yok'],
      ['basic', 'Basic'],
    ]);
    const authSet = fieldset({ legend: 'Tür', content: authRadios.node, className: 'ig-seg-field' });
    const userIn = input({ name: 'kullanici', maxlength: 200, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const passHint = el('span');
    const pw = passwordField('Şifre', { name: 'sifre', autocomplete: 'new-password', maxlength: 500 }, passHint);
    const passIn = pw.input;
    const basicBox = el('div', { className: 'ig-pair ig-basic' }, field({ label: 'Kullanıcı adı', input: userIn }), pw.field);
    const authNote = el('div', { className: 'ig-auth-note' });
    const keySlot = el('div', { className: 'form-alert', tabindex: '-1' });

    function applyAuth() {
      const basic = authRadios.value === 'basic';
      basicBox.hidden = !basic;
      const stored = storedPassword();
      passHint.textContent = stored
        ? 'Kayıtlı şifre var — değiştirmek için yazın. Boş bırakırsanız kayıtlı şifre korunur.'
        : 'Şifre sunucuda şifrelenerek saklanır ve hiçbir yanıtta geri dönmez.';
      passIn.placeholder = stored ? 'Kayıtlı şifre korunuyor' : '';
      fill(authNote, !basic && saved?.kimlik?.tur === 'basic' ? alertBox('info', null, ['Kaydedince kayıtlı kullanıcı adı ve şifre silinir.']) : null);
    }

    function authPayload() {
      if (authRadios.value !== 'basic') return { tur: 'yok' };
      const k = { tur: 'basic', kullanici: userIn.value.trim() };
      if (passIn.value) k.sifre = passIn.value;
      return k;
    }

    // ---------- Extra headers ----------

    const hdrList = el('div', { className: 'ig-hdr-list' });
    const hdrErr = el('p', { className: 'field-error', hidden: true });
    const hdrAdd = btn('Başlık ekle', { icon: ICONS.plus, size: 'sm', onClick: addHeader });

    function headerNode(h, i) {
      const n = i + 1;
      const base = `ig-h-${h.key}`;
      const refs = {};
      refs.ad = input({ className: 'input mono', id: `${base}-a`, value: h.ad, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'X-Kaynak', 'aria-label': `${n}. başlığın adı`, 'aria-describedby': `${base}-ae` });
      refs.adErr = el('p', { className: 'field-error', id: `${base}-ae`, hidden: true });
      refs.deger = input({ id: `${base}-d`, value: h.deger, maxlength: 1000, autocomplete: 'off', spellcheck: 'false', placeholder: 'masraf', 'aria-label': `${n}. başlığın değeri`, 'aria-describedby': `${base}-de` });
      refs.degerErr = el('p', { className: 'field-error', id: `${base}-de`, hidden: true });
      refs.ad.addEventListener('input', () => {
        h.ad = refs.ad.value;
        touch(`hdr:${h.key}:ad`);
      });
      refs.deger.addEventListener('input', () => {
        h.deger = refs.deger.value;
        touch(`hdr:${h.key}:deger`);
      });
      const del = btn('Kaldır', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', onClick: () => removeHeader(h.key), attrs: { 'data-act': 'del', 'aria-label': `${n}. başlığı kaldır` } });
      refs.row = el('div', { className: 'ig-hdr-row', 'data-key': h.key }, el('div', { className: 'ig-hdr-cell' }, refs.ad, refs.adErr), el('div', { className: 'ig-hdr-cell' }, refs.deger, refs.degerErr), del);
      hdrRefs.set(h.key, refs);
      return refs.row;
    }

    function renderHeaders(focus = null) {
      hdrRefs.clear();
      fill(
        hdrList,
        headers.length ? el('div', { className: 'ig-hdr-row ig-hdr-head', 'aria-hidden': 'true' }, el('span', { text: 'Başlık adı' }), el('span', { text: 'Değer' }), el('span')) : null,
        headers.map(headerNode),
      );
      hdrList.hidden = headers.length === 0;
      hdrAdd.disabled = headers.length >= MAX_HEADERS;
      hdrAdd.title = headers.length >= MAX_HEADERS ? `En çok ${MAX_HEADERS} başlık eklenebilir.` : '';
      if (!focus) return;
      const refs = focus.key ? hdrRefs.get(focus.key) : null;
      if (refs) (focus.act ? refs.row.querySelector(`[data-act="${focus.act}"]`) : refs[focus.prop ?? 'ad'])?.focus();
      else hdrAdd.focus();
    }

    function addHeader() {
      if (headers.length >= MAX_HEADERS) return;
      const h = { key: newKey(), ad: '', deger: '' };
      headers.push(h);
      renderHeaders({ key: h.key, prop: 'ad' });
      changed();
    }

    function removeHeader(key) {
      const i = headers.findIndex((h) => h.key === key);
      if (i < 0) return;
      headers.splice(i, 1);
      dropErrors(`hdr:${key}:`);
      const next = headers[i] ?? headers[i - 1];
      renderHeaders(next ? { key: next.key, act: 'del' } : { add: true });
      announce(`${i + 1}. başlık kaldırıldı.`);
      changed();
    }

    // ---------- Field mapping ----------

    const mapSub = el('p', { className: 'card-sub' });
    const mapErr = el('p', { className: 'field-error', hidden: true });

    function makeGroup(level) {
      const headId = `ig-g-${level}`;
      const tbody = el('tbody');
      const add = btn(level === 'form' ? 'Form alanı ekle' : 'Fiş alanı ekle', { icon: ICONS.plus, size: 'sm', onClick: () => pickSources(level) });
      const sub = el('p', { className: 'ig-group-sub' });
      const empty = el('p', { className: 'muted ig-group-empty', text: level === 'form' ? 'Henüz form alanı eşlenmedi.' : 'Henüz fiş alanı eşlenmedi; gövdede fiş listesi yazılmaz.' });
      const table = el(
        'div',
        { className: 'table-scroll' },
        el(
          'table',
          { className: 'data-table ig-map-table' },
          el('caption', { className: 'visually-hidden', text: level === 'form' ? 'Form alanları, gövdedeki sırayla' : 'Fiş alanları, gövdedeki sırayla' }),
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col', className: 't-order', text: 'Sıra' }),
              el('th', { scope: 'col', text: 'Kaynak alan' }),
              el('th', { scope: 'col', text: 'Ad (alias)' }),
              el('th', { scope: 'col', text: 'Tür / değer' }),
              el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'Kaldır' })),
            ),
          ),
          tbody,
        ),
      );
      const node = el(
        'section',
        { className: `ig-group ig-group-${level}`, 'aria-labelledby': headId },
        el(
          'div',
          { className: 'ig-group-head' },
          el('div', { className: 'ig-group-text' }, el('h3', { className: 'ig-group-title', id: headId, text: level === 'form' ? 'Form alanları' : 'Fiş alanları (her fatura için)' }), sub),
          add,
        ),
        empty,
        table,
      );
      return { node, tbody, add, sub, empty, table };
    }
    const groups = { form: makeGroup('form'), fis: makeGroup('fis') };

    function fillSourceOptions(sel, level, current) {
      const kids = [];
      if (current && !sourceOf(level, current)) kids.push(el('option', { value: current, text: `${current} (silinmiş)` }));
      for (const g of sourceGroups(sources, level)) {
        kids.push(el('optgroup', { label: g.title }, ...g.items.map((s) => el('option', { value: s.anahtar, text: s.aktif === false ? `${s.ad} (pasif)` : s.ad }))));
      }
      fill(sel, kids);
      sel.value = current;
    }

    /** The parts of a row that follow its source: the key under the select, the type or the constant. */
    function fillRowSource(r, refs) {
      const src = sourceOf(refs.level, r.kaynak);
      fill(
        refs.meta,
        el('span', { className: 'mono', text: r.kaynak }),
        src?.aktif === false ? el('span', { className: 'tag', text: 'Pasif alan: değeri boş gider' }) : null,
        !src ? el('span', { className: 'tag warn', text: 'Silinmiş' }) : null,
      );
      refs.tr.classList.toggle('is-off', src?.aktif === false);
      if (isConst(r.kaynak)) {
        refs.valueCell.setAttribute('data-label', 'Sabit değer');
        refs.deger = input({ id: `${refs.base}-d`, value: r.deger, maxlength: 200, autocomplete: 'off', spellcheck: 'false', placeholder: 'Örn. 1000', 'aria-label': `${refs.n}. ${refs.what}: sabit değer`, 'aria-describedby': `${refs.base}-de` });
        refs.degerErr = el('p', { className: 'field-error', id: `${refs.base}-de`, hidden: true });
        refs.deger.addEventListener('input', () => {
          r.deger = refs.deger.value;
          touch(`row:${r.key}:deger`);
        });
        fill(refs.valueCell, refs.deger, refs.degerErr);
      } else {
        refs.valueCell.setAttribute('data-label', 'Tür');
        refs.deger = null;
        refs.degerErr = null;
        fill(refs.valueCell, el('span', { className: 'tag', title: 'Değerin yazılış biçimi önizlemede görünür.', text: src ? (TYPE_LABEL[src.tur] ?? src.tur) : '—' }));
      }
    }

    function rowNode(level, r, i, count) {
      const n = i + 1;
      const what = level === 'form' ? 'form alanı' : 'fiş alanı';
      const whatAcc = level === 'form' ? 'form alanını' : 'fiş alanını';
      const base = `ig-r-${r.key}`;
      const refs = { level, n, what, base };
      refs.kaynak = el('select', { className: 'input', id: `${base}-k`, 'aria-label': `${n}. ${what}: kaynak`, 'aria-describedby': `${base}-km ${base}-ke` });
      fillSourceOptions(refs.kaynak, level, r.kaynak);
      refs.meta = el('p', { className: 'ig-src-meta', id: `${base}-km` });
      refs.kaynakErr = el('p', { className: 'field-error', id: `${base}-ke`, hidden: true });
      refs.alias = input({ className: 'input mono', id: `${base}-a`, value: r.alias, maxlength: ALIAS_MAX, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': `${n}. ${what}: ad (alias)`, 'aria-describedby': `${base}-ae` });
      refs.aliasErr = el('p', { className: 'field-error', id: `${base}-ae`, hidden: true });
      refs.valueCell = el('td', { className: 't-value' });
      // "input" (not "change") so the row is up to date before the editor-wide listener runs.
      refs.kaynak.addEventListener('input', () => changeSource(r, refs));
      refs.alias.addEventListener('input', () => {
        r.alias = refs.alias.value;
        touch(`row:${r.key}:alias`);
      });
      refs.tr = el(
        'tr',
        { 'data-key': r.key },
        el(
          'td',
          { className: 't-order' },
          el(
            'span',
            { className: 'ig-move' },
            el('span', { className: 'order-n', 'aria-hidden': 'true', text: String(n) }),
            btn('Yukarı taşı', { icon: ICONS.arrowUp, size: 'sm', iconOnly: true, disabled: i === 0, onClick: () => moveRow(level, r.key, -1), attrs: { 'data-act': 'up', 'aria-label': `${n}. ${whatAcc} yukarı taşı` } }),
            btn('Aşağı taşı', { icon: ICONS.arrowDown, size: 'sm', iconOnly: true, disabled: i === count - 1, onClick: () => moveRow(level, r.key, 1), attrs: { 'data-act': 'down', 'aria-label': `${n}. ${whatAcc} aşağı taşı` } }),
          ),
        ),
        el('td', { className: 't-src', 'data-label': 'Kaynak alan' }, refs.kaynak, refs.meta, refs.kaynakErr),
        el('td', { className: 't-alias', 'data-label': 'Ad (alias)' }, refs.alias, refs.aliasErr),
        refs.valueCell,
        el('td', { className: 't-actions' }, btn('Kaldır', { icon: ICONS.trash, size: 'sm', iconOnly: true, kind: 'danger-ghost', onClick: () => removeRow(level, r.key), attrs: { 'data-act': 'del', 'aria-label': `${n}. ${whatAcc} kaldır` } })),
      );
      rowRefs.set(r.key, refs);
      fillRowSource(r, refs);
      return refs.tr;
    }

    function renderGroup(level, focus = null) {
      const g = groups[level];
      const rows = rowsOf(level);
      for (const [key, refs] of rowRefs) if (refs.level === level) rowRefs.delete(key);
      fill(g.tbody, rows.map((r, i) => rowNode(level, r, i, rows.length)));
      g.table.hidden = rows.length === 0;
      g.empty.hidden = rows.length > 0;
      updateCounts();
      if (!focus) return;
      if (focus.add) {
        g.add.focus();
        return;
      }
      const refs = rowRefs.get(focus.key);
      if (!refs) return;
      if (focus.act) {
        const other = { up: 'down', down: 'up' }[focus.act];
        const candidates = [focus.act, other].filter(Boolean).map((a) => refs.tr.querySelector(`[data-act="${a}"]`));
        (candidates.find((b) => b && !b.disabled) ?? refs.alias).focus();
      } else {
        (refs[focus.prop ?? 'alias'] ?? refs.alias).focus();
      }
    }

    function takenAliases(level, exceptKey = null) {
      const taken = new Set(
        rowsOf(level)
          .filter((r) => r.key !== exceptKey)
          .map((r) => r.alias.trim().toLowerCase())
          .filter(Boolean),
      );
      if (level === 'form' && listIn.value.trim()) taken.add(listIn.value.trim().toLowerCase());
      return taken;
    }

    function changeSource(r, refs) {
      r.kaynak = refs.kaynak.value;
      // A name the editor suggested follows the source; one the admin typed stays.
      if (!r.alias.trim() || r.alias === r.autoAlias) {
        const next = isConst(r.kaynak) ? '' : uniqueAlias(aliasFor(r.kaynak), takenAliases(refs.level, r.key));
        r.alias = next;
        r.autoAlias = next;
        refs.alias.value = next;
      }
      fillRowSource(r, refs);
      touch(`row:${r.key}:kaynak`);
    }

    function addRows(level, keys) {
      const rows = rowsOf(level);
      const taken = takenAliases(level);
      const added = keys.map((kaynak) => {
        const alias = isConst(kaynak) ? '' : uniqueAlias(aliasFor(kaynak), taken);
        if (alias) taken.add(alias.toLowerCase());
        return { key: newKey(), kaynak, alias, deger: '', autoAlias: alias };
      });
      rows.push(...added);
      renderGroup(level, { key: added[0].key, prop: 'alias' });
      announce(`${fmtCount(added.length)} ${level === 'form' ? 'form' : 'fiş'} alanı eklendi; adlarını değiştirebilirsiniz.`);
      changed();
    }

    function moveRow(level, key, dir) {
      const rows = rowsOf(level);
      const i = rows.findIndex((r) => r.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j], rows[i]];
      renderGroup(level, { key, act: dir < 0 ? 'up' : 'down' });
      const r = rows[j];
      announce(`${quoted(r.alias.trim() || sourceName(level, r.kaynak))} ${j + 1}. sıraya taşındı.`);
      changed();
    }

    function removeRow(level, key) {
      const rows = rowsOf(level);
      const i = rows.findIndex((r) => r.key === key);
      if (i < 0) return;
      const [gone] = rows.splice(i, 1);
      dropErrors(`row:${key}:`);
      const next = rows[i] ?? rows[i - 1];
      renderGroup(level, next ? { key: next.key, act: 'del' } : { add: true });
      announce(`${quoted(gone.alias.trim() || sourceName(level, gone.kaynak))} kaldırıldı.`);
      changed();
    }

    /** "Alan ekle": many sources at once, each with a suggested alias. */
    function pickSources(level) {
      const room = MAX_ROWS - (formRows.length + fisRows.length);
      if (room <= 0) {
        toast(`En çok ${MAX_ROWS} satır eşlenebilir.`, 'err');
        return;
      }
      const mapped = new Set(rowsOf(level).map((r) => r.kaynak));
      const search = input({ type: 'search', autocomplete: 'off', placeholder: 'Ad ya da anahtar' });
      const count = el('p', { className: 'hint ig-pick-count', 'aria-live': 'polite' });
      const checks = [];
      const groupNodes = sourceGroups(sources, level).map((g) => {
        const items = g.items.map((s) => {
          const cid = uid('src');
          const box = el('input', { type: 'checkbox', className: 'check', id: cid, value: s.anahtar });
          box.addEventListener('change', updateCount);
          checks.push(box);
          return el(
            'label',
            { className: 'check-label wrap fa-target ig-pick-item', for: cid, 'data-q': `${s.ad} ${s.anahtar}`.toLocaleLowerCase('tr-TR') },
            box,
            el('span', { className: 'ig-pick-text' }, el('span', { text: s.ad }), el('span', { className: 'mono ig-pick-key', text: s.anahtar })),
            s.aktif === false ? el('span', { className: 'tag', text: 'Pasif' }) : null,
            mapped.has(s.anahtar) ? el('span', { className: 'tag accent', text: 'Eşlendi' }) : null,
          );
        });
        return el('div', { className: 'fa-target-group', role: 'group', 'aria-label': g.title }, el('p', { className: 'fa-target-title', text: g.title }), el('div', { className: 'fa-target-list' }, ...items));
      });
      const noMatch = el('p', { className: 'muted small', hidden: true, text: 'Aramaya uyan alan yok.' });
      function updateCount() {
        const n = checks.filter((c) => c.checked).length;
        count.textContent = n ? `${fmtCount(n)} alan seçildi.` : 'Birden çok alan seçebilirsiniz.';
      }
      search.addEventListener('input', () => {
        const q = search.value.trim().toLocaleLowerCase('tr-TR');
        let any = false;
        for (const g of groupNodes) {
          let visible = 0;
          for (const label of g.querySelectorAll('.ig-pick-item')) {
            const hit = !q || label.dataset.q.includes(q);
            label.hidden = !hit;
            if (hit) visible += 1;
          }
          g.hidden = visible === 0;
          any ||= visible > 0;
        }
        noMatch.hidden = any;
      });
      updateCount();
      openDialog({
        title: level === 'form' ? 'Form alanı ekle' : 'Fiş alanı ekle',
        description:
          level === 'form'
            ? 'Seçtikleriniz listenin sonuna önerilen adlarla eklenir; adları sonra değiştirebilirsiniz. Aynı alan farklı adlarla birden çok kez eşlenebilir.'
            : 'Fiş düzeyindeki alanlar formdaki her fatura için ayrı yazılır. Pasif fiş alanlarının değeri boş gider.',
        size: 'wide',
        body: [field({ label: 'Ara', input: search }), el('div', { className: 'fa-targets ig-pick' }, ...groupNodes), noMatch, count],
        submitLabel: 'Ekle',
        submitIcon: ICONS.plus,
        onSubmit: (ctl) => {
          const chosen = checks.filter((c) => c.checked).map((c) => c.value);
          if (chosen.length === 0) {
            ctl.setError('En az bir alan seçin.');
            return false;
          }
          if (chosen.length > room) {
            ctl.setError(`En çok ${fmtCount(room)} satır daha eklenebilir (toplam ${MAX_ROWS}).`);
            return false;
          }
          return chosen;
        },
      }).done.then((chosen) => {
        if (Array.isArray(chosen) && alive) addRows(level, chosen);
      });
    }

    function updateCounts() {
      const total = formRows.length + fisRows.length;
      mapSub.textContent = `Her satır bir kaynak alanı bir ada (alias) bağlar; satırların sırası gövdedeki sıradır. Gövdede önce form alanları, sonra fiş listesi yazılır. ${fmtCount(total)} / ${MAX_ROWS} satır.`;
      for (const g of Object.values(groups)) {
        g.add.disabled = total >= MAX_ROWS;
        g.add.title = total >= MAX_ROWS ? `En çok ${MAX_ROWS} satır eşlenebilir.` : '';
      }
      groups.form.sub.textContent = 'Gövdede bir kez yazılır.';
      groups.fis.sub.textContent = `Formdaki her fatura için ${quoted(listIn.value.trim() || BLANK.fisListesi)} listesine bir öğe olarak yazılır.`;
    }

    // ---------- Problems: checked here, refined by the preview and the save ----------

    function clientProblems() {
      const p = new Map();
      const xml = formatRadios.value === 'xml';
      const ad = nameIn.value.trim();
      if (!ad) p.set('ad', 'Entegrasyona bir ad verin.');
      else if (ad.length > NAME_MAX) p.set('ad', `En çok ${NAME_MAX} karakter olabilir.`);
      const addr = addressProblem(addrIn.value.trim());
      if (addr) p.set('adres', addr);
      if (!validTimeout(timeoutValue())) p.set('zamanAsimiSn', '5 ile 120 arasında bir tam sayı girin.');
      const kok = kokIn.value.trim();
      if (xml || kok) {
        const m = nameProblem(kok, 'XML için kök adını girin.');
        if (m) p.set('kok', m);
      }
      if (xml) {
        const ns = nsIn.value.trim();
        if (ns.length > 400) p.set('xmlAdAlani', 'En çok 400 karakter olabilir.');
        else if (/[\s"'<>&]/.test(ns)) p.set('xmlAdAlani', 'Boşluk, ", \', <, > ve & kullanılamaz.');
      }
      const listName = listIn.value.trim();
      const lm = nameProblem(listName, 'Fiş listesinin adını girin.');
      if (lm) p.set('fisListesi', lm);
      if (xml) {
        const im = nameProblem(itemIn.value.trim(), 'Fiş öğesinin adını girin.');
        if (im) p.set('fisOgesi', im);
      }
      const total = formRows.length + fisRows.length;
      if (total === 0) p.set('alanlar', 'En az bir alan eşleyin.');
      else if (total > MAX_ROWS) p.set('alanlar', `En çok ${MAX_ROWS} satır eşlenebilir.`);
      for (const level of ['form', 'fis']) {
        const seen = new Set();
        for (const r of rowsOf(level)) {
          if (!sourceOf(level, r.kaynak)) p.set(`row:${r.key}:kaynak`, 'Bu kaynak alan artık yok; başka bir kaynak seçin ya da satırı kaldırın.');
          const alias = r.alias.trim();
          const lower = alias.toLowerCase();
          const m = nameProblem(alias);
          if (m) p.set(`row:${r.key}:alias`, m);
          else if (seen.has(lower)) p.set(`row:${r.key}:alias`, 'Bu ad bu grupta zaten kullanılıyor.');
          else if (level === 'form' && listName && lower === listName.toLowerCase()) p.set(`row:${r.key}:alias`, `Fiş listesinin adıyla (${listName}) aynı olamaz.`);
          if (alias) seen.add(lower);
          if (isConst(r.kaynak)) {
            const v = r.deger.trim();
            if (!v) p.set(`row:${r.key}:deger`, 'Sabit değeri girin.');
            else if (v.length > 200) p.set(`row:${r.key}:deger`, 'En çok 200 karakter olabilir.');
          }
        }
      }
      if (authRadios.value === 'basic') {
        const user = userIn.value.trim();
        if (!user) p.set('kimlik.kullanici', 'Kullanıcı adını girin.');
        else if (user.length > 200) p.set('kimlik.kullanici', 'En çok 200 karakter olabilir.');
        if (!passIn.value && !storedPassword()) p.set('kimlik.sifre', 'Basic kimlik doğrulaması için şifreyi girin.');
        else if (passIn.value.length > 500) p.set('kimlik.sifre', 'En çok 500 karakter olabilir.');
      }
      const used = headers.filter(headerUsed);
      if (used.length > MAX_HEADERS) p.set('basliklar', `En çok ${MAX_HEADERS} başlık eklenebilir.`);
      for (const h of used) {
        const hp = headerProblem(h);
        if (hp?.ad) p.set(`hdr:${h.key}:ad`, hp.ad);
        if (hp?.deger) p.set(`hdr:${h.key}:deger`, hp.deger);
      }
      return p;
    }

    const simpleTargets = {
      ad: { control: nameIn },
      adres: { control: addrIn },
      yontem: { control: methodSel },
      zamanAsimiSn: { control: timeoutIn },
      bicim: { control: formatSet },
      kok: { control: kokIn },
      xmlAdAlani: { control: nsIn },
      fisListesi: { control: listIn },
      fisOgesi: { control: itemIn },
      tarihBicimi: { control: dateSel },
      tetikleyici: { control: triggerSet },
      'kimlik.tur': { control: authSet },
      'kimlik.kullanici': { control: userIn },
      'kimlik.sifre': { control: passIn },
      alanlar: { control: null, slot: mapErr },
      basliklar: { control: null, slot: hdrErr },
    };

    function targetOf(k) {
      const m = /^(row|hdr):([^:]+):(\w+)$/.exec(k);
      if (m) {
        const refs = (m[1] === 'row' ? rowRefs : hdrRefs).get(m[2]);
        return refs?.[m[3]] ? { control: refs[m[3]], slot: refs[`${m[3]}Err`] } : null;
      }
      return simpleTargets[k] ?? null;
    }

    /** A server path ("alanlar.2.alias", "basliklar.0.ad", "kimlik.sifre") → the editor's error key. */
    function errKeyOf(path, snap) {
      let m = /^alanlar\.(\d+)(?:\.(kaynak|alias|deger))?/.exec(path);
      if (m) {
        const key = snap.rows[Number(m[1])];
        return key ? `row:${key}:${m[2] ?? 'kaynak'}` : 'alanlar';
      }
      m = /^basliklar\.(\d+)(?:\.(ad|deger))?/.exec(path);
      if (m) {
        const key = snap.headers[Number(m[1])];
        return key ? `hdr:${key}:${m[2] ?? 'ad'}` : 'basliklar';
      }
      if (path === 'kimlik') return 'kimlik.tur';
      return path;
    }

    function labelOfKey(k) {
      const m = /^(row|hdr):([^:]+):(\w+)$/.exec(k);
      if (m?.[1] === 'row') {
        for (const level of ['form', 'fis']) {
          const rows = rowsOf(level);
          const i = rows.findIndex((r) => r.key === m[2]);
          if (i >= 0) return `${level === 'form' ? 'Form' : 'Fiş'} alanı ${i + 1} (${rows[i].alias.trim() || sourceName(level, rows[i].kaynak)})`;
        }
        return KEY_LABEL.alanlar;
      }
      if (m) {
        const i = headers.findIndex((h) => h.key === m[2]);
        return i >= 0 ? `${i + 1}. başlık` : KEY_LABEL.basliklar;
      }
      return KEY_LABEL[k] ?? k;
    }

    function setError(k, message) {
      const t = targetOf(k);
      if (!t) return;
      const node = t.slot ?? t.control;
      if (!node) return;
      // Skip unchanged messages, unless something else cleared it (the password box clears its own).
      const on = t.slot ? !t.slot.hidden : t.control.getAttribute('aria-invalid') === 'true';
      if (shown.get(node) === (message ?? '') && on === Boolean(message)) return;
      shown.set(node, message ?? '');
      if (t.slot) slotError(t.control, t.slot, message);
      else setFieldError(t.control, message);
    }

    /** Puts every current message under its control; returns the editor's own problems. */
    function updateErrors() {
      const client = clientProblems();
      const visible = (k) => attempted || touched.has(k) || /^row:.*:kaynak$/.test(k);
      const messageOf = (k) => (visible(k) ? client.get(k) : null) ?? serverErr.get(k) ?? (visible(k) ? previewErr.get(k) : null) ?? null;
      for (const k of SIMPLE_KEYS) setError(k, messageOf(k));
      for (const [key, refs] of rowRefs) for (const prop of ['kaynak', 'alias', 'deger']) if (refs[prop]) setError(`row:${key}:${prop}`, messageOf(`row:${key}:${prop}`));
      for (const key of hdrRefs.keys()) for (const prop of ['ad', 'deger']) setError(`hdr:${key}:${prop}`, messageOf(`hdr:${key}:${prop}`));
      return client;
    }

    function touch(k) {
      touched.add(k);
      serverErr.delete(k);
      previewErr.delete(k);
    }

    function dropErrors(prefix) {
      for (const map of [serverErr, previewErr]) for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    }

    function resetChecks() {
      attempted = false;
      touched.clear();
      serverErr.clear();
      previewErr.clear();
      fill(alertSlot);
      fill(keySlot);
    }

    function focusFirstError() {
      const t = editorEl.querySelector('[aria-invalid="true"]');
      if (t) {
        (t.matches('fieldset') ? t.querySelector('input:checked, input') : t)?.focus();
        return true;
      }
      if (!mapErr.hidden) {
        groups.form.add.focus();
        return true;
      }
      if (!hdrErr.hidden) {
        hdrAdd.focus();
        return true;
      }
      return false;
    }

    // ---------- The input the server gets ----------

    function timeoutValue() {
      const v = timeoutIn.value.trim();
      return v === '' ? null : Number(v);
    }

    /**
     * The EntegrasyonGirdi on screen, and which row and header each array index is (for the server's
     * `alanlar` paths). For the preview: no credentials, stand-ins for a name, address or timeout the
     * admin has not finished, and only the extra headers that pass the checks (none of these shape
     * the body; a broken one would only keep the preview from showing).
     */
    function buildInput({ preview = false } = {}) {
      const xml = formatRadios.value === 'xml';
      const ad = nameIn.value.trim();
      const adres = addrIn.value.trim();
      const timeout = timeoutValue();
      const rows = [...formRows, ...fisRows];
      const sentHeaders = headers.filter((h) => headerUsed(h) && (!preview || !headerProblem(h)));
      const data = {
        ad: preview && (!ad || ad.length > NAME_MAX) ? 'Önizleme' : ad,
        aktif: isActive(),
        adres: preview && addressProblem(adres) ? PREVIEW_ADDRESS : adres,
        yontem: methodSel.value === 'PUT' ? 'PUT' : 'POST',
        bicim: xml ? 'xml' : 'json',
        kok: kokIn.value.trim() || null,
        xmlAdAlani: xml ? nsIn.value.trim() || null : null,
        fisListesi: listIn.value.trim(),
        // Used by XML only, but always filled (contract); a JSON integration keeps the default.
        fisOgesi: itemIn.value.trim() || (xml ? '' : BLANK.fisOgesi),
        tarihBicimi: dateSel.value,
        tetikleyici: triggerValue(),
        kimlik: preview ? { tur: 'yok' } : authPayload(),
        basliklar: sentHeaders.map((h) => ({ ad: h.ad.trim(), deger: h.deger.trim() })),
        zamanAsimiSn: preview && !validTimeout(timeout) ? BLANK.zamanAsimiSn : timeout,
        alanlar: rows.map((r) => (isConst(r.kaynak) ? { kaynak: r.kaynak, alias: r.alias.trim(), deger: r.deger.trim() } : { kaynak: r.kaynak, alias: r.alias.trim() })),
      };
      return { data, snap: { rows: rows.map((r) => r.key), headers: sentHeaders.map((h) => h.key) } };
    }

    function signature() {
      const { data } = buildInput();
      return JSON.stringify({ ...data, kimlik: { ...data.kimlik, sifre: Boolean(data.kimlik.sifre) } });
    }
    const isDirty = () => loaded && signature() !== savedSig;

    // ---------- Showing an integration ----------

    function applyValues(it) {
      nameIn.value = it.ad ?? '';
      setActive(it.aktif !== false);
      addrIn.value = it.adres ?? '';
      methodSel.value = it.yontem === 'PUT' ? 'PUT' : 'POST';
      timeoutIn.value = it.zamanAsimiSn === null || it.zamanAsimiSn === undefined ? '' : String(it.zamanAsimiSn);
      formatRadios.set(it.bicim === 'xml' ? 'xml' : 'json');
      kokIn.value = it.kok ?? '';
      nsIn.value = it.xmlAdAlani ?? '';
      listIn.value = it.fisListesi ?? BLANK.fisListesi;
      itemIn.value = it.fisOgesi ?? BLANK.fisOgesi;
      dateSel.value = DATE_FORMATS.some((d) => d.value === it.tarihBicimi) ? it.tarihBicimi : BLANK.tarihBicimi;
      setTrigger(it.tetikleyici);
      authRadios.set(it.kimlik?.tur === 'basic' ? 'basic' : 'yok');
      userIn.value = it.kimlik?.kullanici ?? '';
      passIn.value = '';
      headers = arr(it.basliklar).map((h) => ({ key: newKey(), ad: String(h.ad ?? ''), deger: String(h.deger ?? '') }));
      const rows = arr(it.alanlar).map((a) => ({ key: newKey(), kaynak: String(a.kaynak ?? ''), alias: String(a.alias ?? ''), deger: String(a.deger ?? ''), autoAlias: null }));
      formRows = rows.filter((r) => levelOf(r.kaynak) === 'form');
      fisRows = rows.filter((r) => levelOf(r.kaynak) === 'fis');
      applyFormat();
      applyAuth();
      renderGroup('form');
      renderGroup('fis');
      renderHeaders();
    }

    function changedLine(it) {
      const when = fmtDateTime(it.guncelleme ?? it.olusturma);
      if (!when) return 'Gönderim adresi, gövde biçimi ve alan eşlemesi.';
      return `Son değişiklik ${when}${it.guncelleyen?.adSoyad ? `, ${it.guncelleyen.adSoyad}` : ''}.`;
    }

    function renderIdentity() {
      const isNew = id === null;
      titleEl.textContent = isNew ? 'Yeni entegrasyon' : saved.ad;
      subEl.textContent = isNew ? 'Adresi, gövde biçimini ve alan eşlemesini girin; önizleme siz yazdıkça güncellenir.' : changedLine(saved);
      copyBtn.hidden = isNew;
      deleteBtn.hidden = isNew;
      if (!isNew) copyBtn.setAttribute('href', `#${ROUTE}/yeni?kopya=${encodeURIComponent(String(id))}`);
      const resetLabel = resetBtn.querySelector('span');
      if (resetLabel) resetLabel.textContent = isNew ? 'Vazgeç' : 'Değişiklikleri geri al';
      const problems = arr(saved?.sorunlar);
      fill(issuesSlot, problems.length ? alertBox('warn', 'Bu entegrasyonda sorun var; düzeltilene kadar gönderimleri hata olur.', problems) : null);
      sendCard.hidden = isNew;
      if (!isNew && !log) {
        log = sendLog({ signal, integrationId: id, status: '' });
        logSlot.append(log.node);
        log.load();
      }
      setPageTitle(`${isNew ? 'Yeni entegrasyon' : saved.ad} · Entegrasyonlar`);
    }

    function show(it) {
      saved = it;
      id = it.id;
      resetChecks();
      applyValues(it);
      savedSig = signature();
      renderIdentity();
      updateDirty();
      updateErrors();
      doPreview(false);
    }

    function startNew(copy) {
      saved = null;
      id = null;
      resetChecks();
      applyValues(BLANK);
      savedSig = signature(); // a blank new integration is not unsaved work yet
      if (copy) {
        applyValues({
          ...copy,
          ad: `${copy.ad} (kopya)`.slice(0, NAME_MAX),
          aktif: false,
          kimlik: copy.kimlik?.tur === 'basic' ? { tur: 'basic', kullanici: copy.kimlik.kullanici ?? '' } : { tur: 'yok' },
        });
        fill(alertSlot, alertBox('info', null, [`${quoted(copy.ad)} entegrasyonunun kopyası: kopya pasif başlar${copy.kimlik?.tur === 'basic' ? ' ve kayıtlı şifre kopyalanmaz, yeniden girin' : ''}.`]));
      }
      renderIdentity();
      updateDirty();
      updateErrors();
    }

    // ---------- Save bar ----------

    const dirtyNote = el('p', { className: 'dirty-note', role: 'status' });
    const resetBtn = btn(creating ? 'Vazgeç' : 'Değişiklikleri geri al', { kind: 'ghost', onClick: () => (id === null ? navigate(ROUTE) : saved && show(saved)) });
    const saveBtn = btn('Kaydet', { icon: ICONS.check, kind: 'primary', onClick: save });

    function updateDirty() {
      const dirty = isDirty();
      const text = dirty ? 'Kaydedilmemiş değişiklikler var' : id === null ? 'Yeni entegrasyon henüz kaydedilmedi' : 'Değişiklikler kaydedildi';
      if (dirtyNote.textContent !== text) dirtyNote.textContent = text;
      dirtyNote.classList.toggle('is-dirty', dirty);
      resetBtn.disabled = id !== null && !dirty;
      sendNote.hidden = !dirty || id === null;
    }

    /** Anything in the editor changed (the editor-wide input listener and the row buttons call it). */
    function changed() {
      if (!loaded) return;
      updateCounts();
      updateDirty();
      updateErrors();
      schedulePreview();
    }

    async function save() {
      if (saving || !loaded) return;
      attempted = true;
      fill(alertSlot);
      fill(keySlot);
      const problems = updateErrors();
      if (problems.size > 0) {
        const items = [...problems].map(([k, m]) => `${labelOfKey(k)}: ${m}`);
        fill(alertSlot, alertBox('err', 'Entegrasyon kaydedilemedi', items.length > 8 ? [...items.slice(0, 8), `… ve ${fmtCount(items.length - 8)} sorun daha`] : items));
        if (!focusFirstError()) alertSlot.focus();
        return;
      }
      const { data, snap } = buildInput();
      const wasNew = id === null;
      saving = true;
      setBusy(saveBtn, true);
      const r = wasNew ? await api.createIntegration(data) : await api.updateIntegration(id, data);
      saving = false;
      setBusy(saveBtn, false);
      if (!alive) return;
      if (!r.ok) {
        if (!r.unauthorized) saveFailed(r.error, snap);
        return;
      }
      show(r.body);
      toast(wasNew ? `${quoted(r.body.ad)} entegrasyonu oluşturuldu.` : `${quoted(r.body.ad)} kaydedildi.`, 'ok');
      if (wasNew) navigate(`${ROUTE}/${r.body.id}`, { replace: true });
    }

    function saveFailed(error, snap) {
      updateDirty();
      if (error.kod === 'entegrasyon_adi_kullaniliyor') {
        serverErr.set('ad', error.mesaj);
        updateErrors();
        nameIn.focus();
        return;
      }
      if (error.kod === 'anahtar_yok') {
        serverErr.set('kimlik.sifre', error.mesaj);
        updateErrors();
        fill(
          keySlot,
          alertBox('err', 'Şifre kaydedilemiyor: şifreleme anahtarı tanımlı değil', [
            error.mesaj,
            'Sunucunun .env dosyasına ENTEGRASYON_ANAHTARI ekleyip sunucuyu yeniden başlatın. Anahtar tanımlanana kadar şifre kaydedilemez; entegrasyonu kimlik doğrulaması “Yok” iken kaydedebilirsiniz.',
          ]),
        );
        keySlot.scrollIntoView({ block: 'center' });
        passIn.focus();
        return;
      }
      if (error.alanlar) {
        serverErr.clear();
        const leftovers = [];
        for (const [path, msg] of Object.entries(error.alanlar)) {
          const k = errKeyOf(String(path).replace(/^entegrasyon\./, ''), snap);
          if (targetOf(k)) serverErr.set(k, String(msg));
          else leftovers.push(`${labelOfKey(k)}: ${msg}`);
        }
        updateErrors();
        const items = [...serverErr].map(([k, m]) => `${labelOfKey(k)}: ${m}`).concat(leftovers);
        fill(alertSlot, alertBox('err', 'Sunucu entegrasyonu kabul etmedi', items.length ? items : [error.mesaj]));
        if (!focusFirstError()) alertSlot.focus();
        return;
      }
      fill(alertSlot, alertBox('err', 'Entegrasyon kaydedilemedi', [error.mesaj]));
      alertSlot.focus();
    }

    async function removeIntegration() {
      if (id === null || !saved) return;
      const target = saved;
      const r = await actionDialog({
        title: 'Entegrasyonu sil',
        message: `${quoted(target.ad)} entegrasyonu silinecek. Bu işlem geri alınamaz.`,
        details: [el('p', { className: 'dlg-text', text: 'Entegrasyonun gönderim kaydı da silinir (bekleyen ve hatalı gönderimler dahil).' })],
        confirmLabel: 'Entegrasyonu sil',
        confirmIcon: ICONS.trash,
        kind: 'danger',
        run: () => api.deleteIntegration(target.id),
      });
      if (!r?.ok || !alive) return;
      leaveOk = true;
      toast(`${quoted(target.ad)} entegrasyonu silindi.`, 'ok');
      navigate(ROUTE);
    }

    // ---------- Live preview ----------

    const pvForm = input({ name: 'onizlemeForm', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Boş: örnek veri', className: 'input input-sm' });
    const pvStatus = el('p', { className: 'ig-pv-status', role: 'status', id: 'ig-pv-status' });
    const pvSpin = el('span', { className: 'ig-spin', 'aria-hidden': 'true', hidden: true });
    const pvType = el('span', { className: 'tag mono ig-ctype', hidden: true });
    const pvProblems = el('div', { className: 'ig-pv-problems' });
    const pvIdle = el('p', { className: 'muted small ig-pv-idle', text: 'Önizleme hazırlanıyor…' });
    const pvCode = el('pre', { className: 'json ig-code ig-pv-code', tabindex: '0', 'aria-label': 'Gövde önizlemesi', 'aria-describedby': 'ig-pv-status', hidden: true });
    const pvCopy = btn('Kopyala', { icon: ICONS.copy, size: 'sm', disabled: true, onClick: () => lastBody && copyText(lastBody, pvCode, 'Gövde'), attrs: { 'aria-label': 'Gövdeyi kopyala' } });
    const previewCard = el(
      'section',
      { className: 'card ig-preview', 'aria-labelledby': 'ig-pv-h' },
      el('div', { className: 'card-head' }, el('h2', { className: 'card-title', id: 'ig-pv-h' }, icon(ICONS.code), el('span', { text: 'Önizleme' })), el('div', { className: 'ig-pv-tools' }, pvSpin, pvCopy)),
      field({ label: 'Form no ile önizle', input: pvForm, optional: true, hint: 'Boşsa örnek verilerle hazırlanır. Hiçbir şey gönderilmez ya da kaydedilmez.', className: 'ig-pv-form' }),
      pvStatus,
      pvType,
      pvProblems,
      pvIdle,
      pvCode,
    );
    pvForm.addEventListener('input', () => schedulePreview());

    const runPreview = debounce(() => doPreview(false), PREVIEW_DELAY);
    function schedulePreview() {
      if (loaded) runPreview();
    }

    function setStatus(text) {
      if (pvStatus.textContent !== text) pvStatus.textContent = text;
    }

    function setPreviewBusy(on) {
      pvSpin.hidden = !on;
      if (on) pvCode.setAttribute('aria-busy', 'true');
      else pvCode.removeAttribute('aria-busy');
    }

    function previewIdle(text) {
      lastBody = '';
      pvIdle.textContent = text;
      pvIdle.hidden = false;
      pvCode.hidden = true;
      pvType.hidden = true;
      pvCopy.disabled = true;
      fill(pvProblems);
      setStatus('');
    }

    function previewShown(o) {
      lastBody = typeof o.govde === 'string' ? o.govde : '';
      fill(pvCode, highlighted(lastBody, kindOf(o.icerikTuru, lastBody)));
      pvCode.hidden = false;
      pvCode.classList.remove('is-stale');
      pvIdle.hidden = true;
      pvType.textContent = o.icerikTuru ? `Content-Type: ${o.icerikTuru}` : '';
      pvType.hidden = !o.icerikTuru;
      pvCopy.disabled = !lastBody;
      fill(pvProblems);
      setStatus(o.ornek || !o.form ? 'Örnek verilerle hazırlandı.' : `#${o.form.id}${o.form.baslik ? ` · ${o.form.baslik}` : ''} formuyla hazırlandı.`);
    }

    function previewFailed(title, items, retry = false) {
      fill(pvProblems, alertBox('warn', title, items), retry ? btn('Tekrar dene', { icon: ICONS.refresh, size: 'sm', onClick: () => doPreview(true) }) : null);
      if (lastBody) pvCode.classList.add('is-stale');
      else pvIdle.hidden = true;
      setStatus(items.length ? `Gövde hazırlanamadı: ${fmtCount(items.length)} sorun.` : title);
    }

    async function doPreview(force) {
      if (!loaded || !alive) return;
      runPreview.cancel();
      const formNo = pvForm.value.trim().replace(/^#/, '');
      const { data, snap } = buildInput({ preview: true });
      const key = JSON.stringify([data, formNo]);
      if (!force && key === previewSig) return;
      previewSig = key;
      previewCtl?.abort();
      previewCtl = null;
      setPreviewBusy(false);
      if (formNo && !/^\d+$/.test(formNo)) {
        setFieldError(pvForm, 'Form numarası bir sayı olmalı (ör. 1001).');
        return;
      }
      setFieldError(pvForm, null);
      if (data.alanlar.length === 0) {
        previewErr.clear();
        updateErrors();
        previewIdle('Alan eşlemesine en az bir alan ekleyin; gövde burada görünür.');
        return;
      }
      const ctl = new AbortController();
      previewCtl = ctl;
      setPreviewBusy(true);
      const r = await api.previewIntegration(data, formNo ? Number(formNo) : null, { signal: ctl.signal });
      if (previewCtl !== ctl || !alive) return;
      previewCtl = null;
      setPreviewBusy(false);
      if (r.ok) {
        previewErr.clear();
        updateErrors();
        previewShown(r.body ?? {});
        return;
      }
      if (r.aborted || r.unauthorized) return;
      previewErr.clear();
      if (r.error.durum === 404) {
        setFieldError(pvForm, r.error.mesaj);
        updateErrors();
        previewFailed(r.error.mesaj, []);
        return;
      }
      if (r.error.alanlar) {
        const items = [];
        for (const [path, msg] of Object.entries(r.error.alanlar)) {
          if (path === 'formId') {
            setFieldError(pvForm, String(msg));
            items.push(`${KEY_LABEL.formId}: ${msg}`);
            continue;
          }
          const k = errKeyOf(String(path).replace(/^entegrasyon\./, ''), snap);
          if (targetOf(k)) previewErr.set(k, String(msg));
          items.push(`${labelOfKey(k)}: ${msg}`);
        }
        updateErrors();
        previewFailed('Gövde hazırlanamadı', items);
        return;
      }
      updateErrors();
      previewSig = null; // e.g. offline: the next change, or "Tekrar dene", asks again
      previewFailed(r.error.mesaj, [], true);
    }

    // ---------- Send by hand ----------

    const sendIn = input({ name: 'formId', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Örn. 1001' });
    const sendBtn = btn('Gönder', { icon: ICONS.send, type: 'submit', kind: 'primary' });
    const sendNote = el('p', { className: 'hint ig-send-note', hidden: true, text: 'Ekrandaki kaydedilmemiş değişiklikler gönderime dahil değildir; gövde kayıtlı eşlemeyle hazırlanır.' });
    const sendResult = el('div', { className: 'ig-send-result', 'aria-live': 'polite' });
    const sendForm = el('form', { className: 'ig-send', novalidate: true }, field({ label: 'Form no', input: sendIn, hint: 'Onaylanmış ya da ödenmiş bir masrafın numarası.' }), sendBtn);
    const sendCard = el(
      'section',
      { className: 'card ig-send-card', 'aria-labelledby': 'ig-send-h', hidden: true },
      el('h2', { className: 'card-title', id: 'ig-send-h', text: 'Elle gönder' }),
      el('p', { className: 'card-sub', text: 'Formu bu entegrasyonla hemen gönderir; entegrasyon pasifken de (deneme için). Her gönderim yeni bir kayıttır.' }),
      sendForm,
      sendNote,
      sendResult,
    );

    const progress = (text) => el('p', { className: 'ig-progress' }, el('span', { className: 'ig-spin', 'aria-hidden': 'true' }), el('span', { text }));
    const detailButton = (sendId) => btn('Ayrıntı', { icon: ICONS.eye, size: 'sm', onClick: () => openSendDetail(sendId, { onChange: () => log?.load() }) });

    function sendOutcome(g) {
      const http = g.httpDurum ? `HTTP ${g.httpDurum}` : null;
      const formText = g.form ? `Masraf #${g.form.id}` : null;
      if (g.durum === 'gonderildi') return alertBox('ok', 'Gönderildi', [[formText, http].filter(Boolean).join(' · ')]);
      if (g.durum === 'hata') return alertBox('err', 'Gönderilemedi', [g.sonHata ?? 'Bilinmeyen bir hata oluştu.', http].filter(Boolean));
      return alertBox('warn', 'İlk deneme başarısız; yeniden denenecek', [g.sonHata, g.sonrakiDeneme ? `Sonraki deneme: ${fmtDateTime(g.sonrakiDeneme)}` : null].filter(Boolean));
    }

    /** Asks every POLL_EVERY ms until the send left "bekliyor" (or failed once and waits for a retry). */
    function poll(sendId, started, token) {
      pollTimer = setTimeout(async () => {
        if (!alive || token !== pollToken) return;
        const r = await api.getIntegrationSend(sendId, { signal });
        if (!alive || token !== pollToken) return;
        if (r.ok) {
          const g = r.body;
          if (g.durum !== 'bekliyor' || ((g.deneme ?? 0) > 0 && g.sonHata)) {
            fill(sendResult, sendOutcome(g), detailButton(sendId));
            log?.load();
            return;
          }
        } else if (r.unauthorized || r.aborted) {
          return;
        } else if (r.error.durum === 404) {
          fill(sendResult, alertBox('err', null, [r.error.mesaj]));
          log?.load();
          return;
        }
        if (Date.now() - started >= POLL_FOR) {
          fill(sendResult, alertBox('info', 'Gönderim sürüyor', [`Sonucu gönderim kaydından izleyebilirsiniz (kayıt #${sendId}).`]), detailButton(sendId));
          log?.load();
          return;
        }
        poll(sendId, started, token);
      }, POLL_EVERY);
    }

    sendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (id === null || sending) return;
      setFieldError(sendIn, null);
      const formNo = sendIn.value.trim().replace(/^#/, '');
      if (!/^\d+$/.test(formNo)) {
        setFieldError(sendIn, 'Masrafın numarasını girin (ör. 1001).');
        sendIn.focus();
        return;
      }
      sending = true;
      pollToken += 1;
      clearTimeout(pollTimer);
      setBusy(sendBtn, true);
      fill(sendResult, progress('Gönderim kuyruğa alınıyor…'));
      const r = await api.sendIntegration(id, Number(formNo));
      sending = false;
      setBusy(sendBtn, false);
      if (!alive) return;
      if (!r.ok) {
        fill(sendResult);
        if (r.unauthorized) return;
        const own = r.error.alanlar?.formId;
        // 404: no such form (or integration); 409 gecersiz_durum: the form is not approved or paid.
        if (own || r.error.durum === 404 || r.error.kod === 'gecersiz_durum') {
          setFieldError(sendIn, String(own ?? r.error.mesaj));
          sendIn.focus();
        } else {
          fill(sendResult, alertBox('err', null, [r.error.mesaj]));
        }
        return;
      }
      const sendId = r.body?.id;
      if (sendId === undefined || sendId === null) {
        fill(sendResult, alertBox('info', 'Gönderim kuyruğa alındı', ['Sonucu gönderim kaydından izleyebilirsiniz.']));
        log?.load();
        return;
      }
      fill(sendResult, progress(`Gönderiliyor… (kayıt #${sendId})`));
      log?.load();
      poll(sendId, Date.now(), pollToken);
    });

    // ---------- Layout ----------

    function card(name, title, sub, ...kids) {
      const headId = `ig-${name}-h`;
      return el(
        'section',
        { className: `card ig-card ig-card-${name}`, 'aria-labelledby': headId },
        el('h2', { className: 'card-title', id: headId, text: title }),
        sub ? el('p', { className: 'card-sub', text: sub }) : null,
        ...kids,
      );
    }

    const generalCard = card(
      'general',
      'Genel',
      null,
      field({ label: 'Ad', input: nameIn, hint: 'En çok 80 karakter; her entegrasyonun adı farklı olmalı (ör. test ve canlı PI).' }),
      el(
        'div',
        { className: 'ig-addr' },
        field({ label: 'Yöntem', input: methodSel }),
        field({ label: 'Adres', input: addrIn, hint: 'http:// ya da https:// ile başlar; yerel ağdaki adresler de olur. Kullanıcı adı ve şifre adrese yazılmaz.' }),
      ),
      el(
        'div',
        { className: 'ig-pair' },
        field({ label: 'Zaman aşımı', input: timeoutIn, control: el('div', { className: 'ig-suffix' }, timeoutIn, el('span', { className: 'ig-suffix-text', 'aria-hidden': 'true', text: 'sn' })), hint: '5–120 saniye.' }),
        el(
          'div',
          { className: 'field' },
          el('span', { className: 'ig-label', 'aria-hidden': 'true', text: 'Durum' }),
          el('div', { className: 'ig-switch' }, activeSw, activeText),
          el('p', { className: 'hint', id: 'ig-active-hint', text: 'Pasif entegrasyon kendiliğinden göndermez; kuyrukta bekleyenler yeniden aktif olunca gider. Elle gönderim pasifken de yapılabilir.' }),
        ),
      ),
    );
    const formatCard = card('format', 'Gövde biçimi', 'Aynı eşleme JSON ve XML’de geçerlidir; biçimi sonradan değiştirebilirsiniz.', formatSet, el('div', { className: 'ig-pair' }, kokField, nsField), el('div', { className: 'ig-pair' }, listField, itemField), dateField);
    const mapCard = el(
      'section',
      { className: 'card ig-card ig-card-map', 'aria-labelledby': 'ig-map-h' },
      el('h2', { className: 'card-title', id: 'ig-map-h', text: 'Alan eşlemesi' }),
      mapSub,
      el(
        'p',
        { className: 'hint ig-rule' },
        icon(ICONS.info),
        el('span', { text: 'Ad (alias) harf ya da _ ile başlar; harf, rakam, _, - ve . içerir; en çok 60 karakterdir ve “xml” ile başlayamaz. Türkçe harf kullanılamaz; böylece aynı eşleme JSON ve XML’de geçerli olur.' }),
      ),
      mapErr,
      groups.form.node,
      groups.fis.node,
    );
    const triggerCard = card('trigger', 'Gönderim zamanı', 'Tetikleyiciye uyan gönderim, formdaki işlemle aynı anda kuyruğa yazılır; gövde gönderim anında hazırlanır.', triggerSet);
    const authCard = card('auth', 'Kimlik doğrulama', 'Basic seçilirse her istekte Authorization başlığı gönderilir. Şifre hiçbir kayda ya da yanıta yazılmaz.', authSet, basicBox, authNote, keySlot);
    const headersCard = card(
      'headers',
      'Ek başlıklar',
      `İsteğe eklenecek HTTP başlıkları (en çok ${MAX_HEADERS}). Content-Type buradan değiştirilebilir.`,
      hdrList,
      hdrErr,
      el('div', { className: 'ig-hdr-foot' }, hdrAdd),
      el('p', { className: 'hint', text: 'Host, Content-Length, Authorization, Connection, Transfer-Encoding, Cookie ve benzeri bağlantı başlıkları kullanılamaz. Değerler gizli sayılmaz ve yanıtta döner; gizli bilgi için Basic kimlik doğrulamasını kullanın.' }),
    );
    const actions = el('div', { className: 'form-actions sticky ig-actions' }, dirtyNote, el('div', { className: 'form-buttons' }, resetBtn, saveBtn));
    const editorEl = el('div', { className: 'ig-main' }, generalCard, formatCard, mapCard, triggerCard, authCard, headersCard, actions);
    const sideEl = el('div', { className: 'ig-side' }, sendCard, previewCard);
    const grid = el('div', { className: 'ig-grid' }, editorEl, sideEl);

    // Every change inside the editor (typing, selects, radios) re-checks, marks unsaved work and
    // refreshes the preview; the controls' own listeners have already updated the rows by then.
    editorEl.addEventListener('input', () => changed());
    for (const [control, k] of [
      [nameIn, 'ad'],
      [methodSel, 'yontem'],
      [kokIn, 'kok'],
      [nsIn, 'xmlAdAlani'],
      [listIn, 'fisListesi'],
      [itemIn, 'fisOgesi'],
      [dateSel, 'tarihBicimi'],
      [userIn, 'kimlik.kullanici'],
      [passIn, 'kimlik.sifre'],
    ]) {
      control.addEventListener('input', () => touch(k));
    }
    // An address or a number half typed is not wrong yet: checked once the admin leaves the box.
    for (const [control, k] of [
      [addrIn, 'adres'],
      [timeoutIn, 'zamanAsimiSn'],
    ]) {
      control.addEventListener('input', () => {
        serverErr.delete(k);
        previewErr.delete(k);
      });
      control.addEventListener('change', () => {
        touch(k);
        updateErrors();
      });
    }
    for (const radio of Object.values(formatRadios.inputs)) {
      radio.addEventListener('input', () => {
        applyFormat();
        touch('bicim');
      });
    }
    for (const radio of Object.values(authRadios.inputs)) {
      radio.addEventListener('input', () => {
        applyAuth();
        touch('kimlik.tur');
      });
    }
    for (const radio of Object.values(triggerInputs)) radio.addEventListener('input', () => touch('tetikleyici'));

    const onBeforeUnload = (e) => {
      if (isDirty() && !saving) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    async function load() {
      const copyParam = creating ? route.query.get('kopya') : null;
      const copyId = copyParam && /^\d+$/.test(copyParam) ? Number(copyParam) : null;
      const wantId = creating ? copyId : id;
      const [s, it] = await Promise.all([api.integrationSources({ signal }), wantId === null ? null : api.getIntegration(wantId, { signal })]);
      if (!alive) return;
      const failed = !s.ok ? s : !creating && it && !it.ok ? it : null;
      if (failed) {
        if (!failed.unauthorized && !failed.aborted) fill(contentSlot, loadFailed(failed, load));
        return;
      }
      sources = normalizeSources(s.body);
      fill(contentSlot, grid);
      loaded = true;
      if (creating) {
        startNew(it?.ok ? it.body : null);
        if (it && !it.ok && !it.unauthorized) toast('Kopyalanacak entegrasyon bulunamadı; boş başlandı.', 'err');
        doPreview(true);
      } else {
        show(it.body); // asks for the preview itself
      }
    }
    load();

    return {
      update(next) {
        // After the first save the address becomes #/entegrasyonlar/<id>: the same editor goes on.
        return next.name === 'entegrasyon' && id !== null && next.params.id === String(id);
      },
      canLeave(next) {
        if (leaveOk) {
          leaveOk = false;
          return true;
        }
        if (!loaded || saving || !isDirty()) return true;
        if (next.name === 'entegrasyon' && id !== null && next.params.id === String(id)) return true;
        return confirmDialog({
          title: 'Kaydedilmemiş değişiklikler',
          message:
            id === null
              ? 'Yeni entegrasyon henüz kaydedilmedi. Devam ederseniz girdikleriniz kaybolur.'
              : `${quoted(saved?.ad ?? '')} entegrasyonundaki değişiklikler kaydedilmedi. Devam ederseniz kaybolur.`,
          confirmLabel: 'Değişiklikleri at',
          kind: 'danger',
        });
      },
      unmount() {
        alive = false;
        runPreview.cancel();
        previewCtl?.abort();
        pollToken += 1;
        clearTimeout(pollTimer);
        log?.stop();
        window.removeEventListener('beforeunload', onBeforeUnload);
      },
    };
  },
};
