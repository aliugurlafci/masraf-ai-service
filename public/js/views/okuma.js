// Fatura okuma: a live monitor of every read on this server (panel or API) and a detail pane for
// one invoice. Addresses: #/okuma, #/okuma/<record id> or #/okuma/a-<activity id>.
//
// The section lives in index.html and stays in the page while other views are open: the live
// connection runs for the whole session, so files sent from here keep their state, the top bar can
// show how many reads are running, and the expense form can follow the read it started.

import * as api from '../api.js';
import { $, el, reducedMotion, replay } from '../dom.js';
import { errorView, invoiceView, jsonView, loadingView, metricsView, originalView, readingView, welcomeView } from '../invoice.js';
import { connectLive } from '../live.js';
import { createMonitor } from '../monitor.js';
import { downloadObjectUrl, knownType, safeObjectUrl, sniffType, typedObjectUrl } from '../files.js';
import { navigate } from '../router.js';
import { setBusy, setFileTarget, setTitleCount, tickClocks, toast } from '../ui.js';
import { fmtCount } from '../format.js';

const section = $('okuma');
const outlet = $('view');
const fileInput = $('file');
const body = $('detail-body');
const detailBar = section.querySelector('.detail-bar');
const tabs = [...section.querySelectorAll('.tab')];
const copyBtn = $('copy');
const downloadBtn = $('download');
const rereadBtn = $('reread');
const expenseBtn = $('to-expense');
const conn = $('conn');

const mobile = matchMedia('(max-width: 760px)');
const ACTIVITY_PATTERN = /^a-[a-f0-9]{12}$/;
// Sending these again gives the same answer, so they get no retry button.
const FINAL_ERRORS = new Set(['desteklenmeyen_dosya', 'dosya_cok_buyuk']);

let active = false; // the view is on screen
let live = null; // the live connection, open while signed in

// ---------- Files sent from this tab: for the original preview, retry and "read again" ----------

const sent = new Map(); // panel tag -> File[] in send order (an activity's sira - 1)
const byRecord = new Map(); // record id -> File
const urls = new WeakMap(); // File -> { url, mime }: an object URL typed by the file's content
const originals = new Map(); // record id -> { state: loading|ok|missing|error, promise, url, type, name, blob, error }

function fileFor(a) {
  if (!a?.etiket) return null;
  return sent.get(a.etiket)?.[(a.sira ?? 1) - 1] ?? null;
}

/** The original of a file this tab sent, typed by its content (never by its name; see files.js). */
function urlOf(file) {
  let entry = urls.get(file);
  if (entry) return entry;
  const type = knownType(file);
  if (type === null) {
    // Reading the first bytes takes a moment; show the original once it is done.
    sniffType(file).then(() => {
      if (active && state.view === 'orijinal') renderDetail(false);
    });
    return null;
  }
  entry = typedObjectUrl(file, type);
  urls.set(file, entry);
  return entry;
}

function localOriginal(file) {
  const o = urlOf(file);
  return o ? originalView({ name: file.name, type: o.mime }, o.url) : loadingView();
}

function remember(a) {
  const file = a.kayitId ? fileFor(a) : null;
  if (file) byRecord.set(a.kayitId, file);
}

const canRetry = (a) => a.durum === 'hata' && !FINAL_ERRORS.has(a.hata?.kod) && fileFor(a) !== null;

const monitor = createMonitor(
  {
    stats: $('stats'),
    lanes: $('lanes'),
    lanesMeta: $('lanes-meta'),
    waiting: $('waiting'),
    feed: $('feed'),
    feedEmpty: $('feed-empty'),
    filters: $('filters'),
    history: $('history'),
  },
  { canRetry },
);

// ---------- Other views follow reads they started (by panel tag) ----------

const tagWatchers = new Map(); // tag -> Set<fn(activity)>
const countWatchers = new Set(); // fn(running count)

/** fn(activity) for every change of a read sent with this panel tag; returns an unsubscribe. */
export function watchTag(tag, fn) {
  let set = tagWatchers.get(tag);
  if (!set) tagWatchers.set(tag, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) tagWatchers.delete(tag);
  };
}

function notifyTag(a) {
  const set = a.etiket ? tagWatchers.get(a.etiket) : null;
  if (set) for (const fn of [...set]) fn(a);
}

/** fn(n): reads waiting or running on the server (for the top bar). */
export function onReadingCount(fn) {
  countWatchers.add(fn);
  return () => countWatchers.delete(fn);
}

/** Files another view sent with this tag, so retry and "Orijinal" work for them here too. */
export function rememberSent(tag, files) {
  sent.set(tag, [...files]);
  for (const f of files) sniffType(f);
}

// ---------- State ----------

const state = {
  target: '', // '' | record id | 'a-' + activity id
  view: 'fatura', // fatura | json | orijinal
  record: null, // { id, body }
  recordError: null,
  loading: null, // id of the record being fetched
  via: null, // the activity the open record came from, for the measurement note
  fresh: false, // the open record was read a moment ago while the panel watched
  pushed: false, // on phones, opening the sheet added a history entry that Back removes
};

/** The panel's latest send: opens the result for the user unless they have opened something else. */
let follow = null;
let loadToken = 0;

// ---------- Routing (inside #/okuma) ----------

function targetFromHash() {
  const path = location.hash.replace(/^#/, '').split('?')[0];
  const m = /^\/okuma\/(.+)$/.exec(path);
  let t = '';
  try {
    t = m ? decodeURIComponent(m[1]) : '';
  } catch {
    // A malformed address opens the start screen.
  }
  return api.ID_PATTERN.test(t) || ACTIVITY_PATTERN.test(t) ? t : '';
}

function setUrl(target, push) {
  const url = target ? `#/okuma/${target}` : '#/okuma';
  if (push) history.pushState({ sheet: true }, '', url);
  else history.replaceState(history.state, '', url);
}

function go(target, { via = null } = {}) {
  if (!active) return;
  state.via = via;
  const push = Boolean(target) && !state.target && mobile.matches;
  if (push) state.pushed = true;
  setUrl(target, push);
  routeTarget(true);
}

function closeDetail() {
  if (state.pushed && history.state?.sheet) history.back();
  else go('');
}

function syncCurrent() {
  const t = state.target;
  if (ACTIVITY_PATTERN.test(t)) monitor.setCurrent({ activityId: t.slice(2), recordId: null });
  else monitor.setCurrent({ activityId: t ? state.via : null, recordId: t || null });
}

function routeTarget(force = false) {
  if (!active) return;
  const target = targetFromHash();
  const changed = target !== state.target;
  state.target = target;
  if (changed) state.view = 'fatura';
  section.classList.toggle('sheet-open', target !== '');

  if (ACTIVITY_PATTERN.test(target)) {
    const a = monitor.get(target.slice(2));
    if (a?.durum === 'bitti' && a.kayitId) {
      state.via = a.id;
      setUrl(a.kayitId, false);
      routeTarget(true);
      return;
    }
    if (!a && monitor.isReady()) {
      toast('Bu okuma artık listede yok; sunucu yeniden başlamış olabilir.');
      setUrl('', false);
      routeTarget(true);
      return;
    }
    state.record = null;
  } else if (target === '') {
    state.record = null;
    state.via = null;
  } else if (state.record?.id !== target) {
    syncCurrent();
    if (state.loading !== target) loadRecord(target);
    else renderDetail(changed || force); // already on its way: show the placeholder meanwhile
    return;
  }
  syncCurrent();
  renderDetail(changed || force);
}

async function loadRecord(id) {
  const token = ++loadToken;
  state.record = null;
  state.recordError = null;
  const cached = api.cachedRecord(id);
  if (cached) {
    state.loading = null;
    state.record = { id, body: cached };
    renderDetail(true);
    return;
  }
  state.loading = id;
  renderDetail(true);
  const r = await api.getRecord(id);
  if (state.loading === id) state.loading = null;
  if (token !== loadToken || state.target !== id || !active) return;
  if (r.ok) state.record = { id, body: r.body };
  else if (r.unauthorized) return;
  else state.recordError = r.error;
  renderDetail(true);
}

// ---------- The original file from the server (GET /api/invoices/:id/dosya) ----------

function nameFor(id) {
  return monitor.recordMeta(id)?.dosyaAdi ?? monitor.latestFor(id)?.dosyaAdi ?? `fatura-${id}`;
}

function loadOriginal(id) {
  const existing = originals.get(id);
  if (existing?.state === 'loading') return existing.promise;
  if (existing?.state === 'ok') return Promise.resolve();
  const promise = api.getInvoiceFile(id).then(async (r) => {
    if (r.ok) {
      const { url, mime } = await safeObjectUrl(r.blob);
      originals.set(id, { state: 'ok', url, type: mime, name: nameFor(id), blob: r.blob });
    } else if (r.unauthorized || r.aborted) {
      originals.delete(id);
    } else {
      originals.set(id, { state: r.notFound ? 'missing' : 'error', error: r.error });
    }
    if (active && state.record?.id === id && state.view === 'orijinal') renderDetail(false);
  });
  originals.set(id, { state: 'loading', promise });
  return promise;
}

function serverOriginal(id) {
  const entry = originals.get(id);
  if (!entry) {
    loadOriginal(id);
    return loadingView();
  }
  if (entry.state === 'loading') return loadingView();
  if (entry.state === 'ok') return originalView({ name: entry.name, type: entry.type }, entry.url);
  const missingFile = entry.state === 'missing';
  return el(
    'div',
    { className: 'notice neutral' },
    el('h2', { text: missingFile ? 'Orijinal dosya yok' : 'Dosya açılamadı' }),
    el('p', {
      text: missingFile
        ? 'Bu kayıt, orijinal dosyalar saklanmaya başlamadan önce okunmuş. Fatura bilgileri "Fatura" sekmesinde.'
        : (entry.error?.mesaj ?? 'Dosya alınamadı.'),
    }),
  );
}

// ---------- Detail pane ----------

function openRecordContext(record) {
  const via = state.via ? monitor.get(state.via) : null;
  return via?.kayitId === record.id ? via : monitor.latestFor(record.id);
}

function renderDetail(animate) {
  if (!active) return;
  const t = state.target;
  const activity = ACTIVITY_PATTERN.test(t) ? monitor.get(t.slice(2)) : null;
  const record = state.record?.id === t ? state.record : null;
  const file = record ? (byRecord.get(record.id) ?? null) : fileFor(activity);
  const hasOriginal = Boolean(file || record);

  if (state.view === 'json' && !record) state.view = 'fatura';
  if (state.view === 'orijinal' && !hasOriginal) state.view = 'fatura';

  detailBar.hidden = t === '';
  for (const tab of tabs) {
    const view = tab.dataset.view;
    if (view === 'json') tab.disabled = !record;
    if (view === 'orijinal') tab.hidden = !hasOriginal;
    const selected = view === state.view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  body.setAttribute('aria-labelledby', `tab-${state.view}`);
  copyBtn.disabled = !record;
  downloadBtn.disabled = !record;
  rereadBtn.hidden = !record;
  expenseBtn.hidden = !record;

  let content;
  let fresh = false;
  if (t === '') content = welcomeView();
  else if (state.view === 'orijinal') content = file ? localOriginal(file) : serverOriginal(record.id);
  else if (state.view === 'json') content = jsonView(record.body);
  else if (activity) content = activity.durum === 'hata' ? errorView(activity.hata, { canRetry: canRetry(activity) }) : readingView(activity);
  else if (record) {
    const meta = monitor.recordMeta(record.id);
    fresh = state.fresh && !reducedMotion.matches;
    state.fresh = false; // the print-in happens once, right after the read the user watched
    content = [
      invoiceView(record.body, { fresh }),
      record.body.olcum ? metricsView(record.body.olcum, { activity: openRecordContext(record), savedAt: meta?.olusturulma ?? null }) : null,
    ];
  } else if (state.recordError) content = errorView(state.recordError, { canRetry: false, title: 'Kayıt açılamadı' });
  else content = loadingView();

  body.replaceChildren(...[content].flat().filter(Boolean));
  if (animate && !fresh && !reducedMotion.matches) replay(body, 'enter');
  if (animate) body.scrollTop = 0;
  tickClocks();
}

// ---------- Live feed ----------

function updateCount(stats) {
  const n = stats ? stats.okunuyor + stats.sirada : 0;
  setTitleCount(n);
  for (const fn of countWatchers) fn(n);
}

let historyTimer = null;
function scheduleHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(loadHistory, 400);
}

async function loadHistory() {
  if (!live) return;
  const list = await api.listRecords();
  if (list && live) monitor.setRecords(list);
}

function followUp(a, before) {
  const f = follow;
  if (!f || f.done || !a.etiket || !f.tags.has(a.etiket)) return;
  // The user opened something else since sending: leave them there.
  if (!active || state.target !== f.base) {
    f.done = true;
    return;
  }
  // On a phone, a send from the list stays on the list; the sheet opens only when already open.
  if (mobile.matches && state.target === '') {
    f.done = true;
    return;
  }
  if (f.single && !before) {
    f.done = true;
    go(`a-${a.id}`);
  } else if (!f.single && a.durum === 'bitti' && a.kayitId) {
    f.done = true;
    go(a.kayitId, { via: a.id });
  }
}

function onSnapshot(snapshot) {
  monitor.applySnapshot(snapshot);
  for (const a of snapshot.etkinlikler) {
    remember(a);
    notifyTag(a);
  }
  updateCount(snapshot.istatistik);
  routeTarget();
}

function onEvent(event) {
  const a = event.etkinlik;
  const before = monitor.applyEvent(event);
  remember(a);
  updateCount(event.istatistik);
  notifyTag(a);
  followUp(a, before);

  // The open activity changed: redraw it, or move on to its record.
  if (active && state.target === `a-${a.id}`) {
    if (a.durum === 'bitti' && a.kayitId) {
      state.via = a.id;
      state.fresh = true;
      setUrl(a.kayitId, false);
      routeTarget(true);
    } else if (!before || before.durum !== a.durum || before.model !== a.model) {
      renderDetail(false);
    }
  }
  // A new record was written, or an open record's measurement note can now say more.
  if (a.durum === 'bitti' && before?.durum !== 'bitti') {
    scheduleHistory();
    if (active && state.record && state.target === a.kayitId && state.view === 'fatura') renderDetail(false);
  }
  tickClocks();
}

function setConnection(s) {
  const wasDown = conn.dataset.state === 'down';
  conn.dataset.state = s;
  conn.querySelector('.conn-text').textContent = { connecting: 'Bağlanıyor', live: 'Canlı', down: 'Bağlantı yok' }[s];
  conn.title = {
    connecting: 'Sunucuya bağlanılıyor.',
    live: 'Panel ve API ile gelen her okuma anında görünür.',
    down: 'Sunucuya ulaşılamıyor; birkaç saniyede bir yeniden denenir.',
  }[s];
  if (s === 'live' && wasDown) loadHistory();
}

/** Opens the live connection for the signed-in user. */
export function startLive() {
  if (live) return;
  live = connectLive({ onSnapshot, onEvent, onState: setConnection });
  loadHistory();
}

/** Sign-out: closes the connection and forgets everything the previous user saw or sent. */
export function resetReading() {
  live?.close();
  live = null;
  clearTimeout(historyTimer);
  sent.clear();
  byRecord.clear();
  for (const o of originals.values()) if (o.url) URL.revokeObjectURL(o.url);
  originals.clear();
  tagWatchers.clear();
  follow = null;
  loadToken++;
  Object.assign(state, { target: '', view: 'fatura', record: null, recordError: null, loading: null, via: null, fresh: false, pushed: false });
  monitor.applySnapshot({ etkinlikler: [], istatistik: null });
  monitor.setRecords([]);
  $('lanes').replaceChildren(); // redrawn from the next user's snapshot; the counters update in place
  $('lanes-meta').textContent = '';
  updateCount(null);
  setConnection('connecting');
}

// ---------- Sending ----------

async function send(files, { force = false } = {}) {
  const list = [...files].filter(Boolean);
  if (list.length === 0) return;
  for (const file of list) sniffType(file);
  const f = { tags: new Set(), single: list.length === 1, base: state.target, done: false };
  follow = f;
  toast(list.length === 1 ? `${list[0].name || 'Dosya'} gönderildi.` : `${fmtCount(list.length)} dosya gönderildi; sırayla okunacak.`);

  if (list.length === 1) {
    const tag = api.newTag();
    sent.set(tag, list);
    f.tags.add(tag);
    const r = await api.sendOne(list[0], { force, tag });
    if (!r.ok) {
      if (!r.unauthorized) toast(r.error.mesaj, 'err');
      return;
    }
    if (r.id) byRecord.set(r.id, list[0]);
    // Without the live feed the answer itself is the only news: open it.
    if (r.id && active && !f.done && state.target === f.base && !(mobile.matches && state.target === '')) {
      f.done = true;
      go(r.id);
    }
    return;
  }

  // One request after another, so the server queues the files in the order they were chosen.
  for (const group of api.splitForSending(list)) {
    const tag = api.newTag();
    sent.set(tag, group);
    f.tags.add(tag);
    const r = await api.sendMany(group, { force, tag });
    if (!r.ok) {
      if (r.unauthorized) return;
      toast(r.error.mesaj, 'err');
    } else for (const d of r.body.dosyalar) if (d.kayitId && group[d.sira - 1]) byRecord.set(d.kayitId, group[d.sira - 1]);
  }
}

function retry(activityId) {
  const a = monitor.get(activityId);
  const file = fileFor(a);
  if (file) send([file]);
}

function openActivity(id) {
  const a = monitor.get(id);
  if (!a) return;
  if (follow) follow.done = true;
  if (a.durum === 'bitti' && a.kayitId) go(a.kayitId, { via: a.id });
  else go(`a-${a.id}`);
}

function downloadName() {
  const base = state.record?.body?.fatura?.faturaNo ?? state.record?.id ?? 'fatura';
  return `fatura-${String(base).replace(/[^\w.-]+/g, '_')}.json`;
}

// ---------- Events (on this section's own controls) ----------

$('upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = ''; // allow choosing the same files again
  send(files);
});

$('back').addEventListener('click', closeDetail);

body.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'pick') fileInput.click();
  if (action === 'retry' && ACTIVITY_PATTERN.test(state.target)) retry(state.target.slice(2));
});

$('feed').addEventListener('click', (e) => {
  const retryId = e.target.closest('[data-retry]')?.dataset.retry;
  if (retryId) {
    retry(retryId);
    return;
  }
  const id = e.target.closest('[data-activity]')?.dataset.activity;
  if (id) openActivity(id);
});

$('lanes').addEventListener('click', (e) => {
  const id = e.target.closest('[data-activity]')?.dataset.activity;
  if (id) openActivity(id);
});

$('history').addEventListener('click', (e) => {
  const id = e.target.closest('[data-record]')?.dataset.record;
  if (!id) return;
  if (follow) follow.done = true;
  go(id);
});

$('filters').addEventListener('click', (e) => {
  const next = e.target.closest('[data-filter]')?.dataset.filter;
  if (next) monitor.setFilter(next);
});

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    if (tab.disabled || state.view === tab.dataset.view) return;
    state.view = tab.dataset.view;
    renderDetail(true);
  });
}

$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const usable = tabs.filter((t) => !t.hidden && !t.disabled);
  const index = usable.findIndex((t) => t.dataset.view === state.view);
  const next = usable[(index + (e.key === 'ArrowRight' ? 1 : usable.length - 1)) % usable.length];
  if (!next) return;
  e.preventDefault();
  state.view = next.dataset.view;
  renderDetail(true);
  next.focus();
});

rereadBtn.addEventListener('click', async () => {
  if (!state.record) return;
  const id = state.record.id;
  let file = byRecord.get(id) ?? null;
  if (!file) {
    // A record this tab did not send: read its original back from the server.
    setBusy(rereadBtn, true);
    await loadOriginal(id);
    setBusy(rereadBtn, false);
    const entry = originals.get(id);
    if (entry?.state !== 'ok') {
      if (entry) {
        toast(entry.state === 'missing' ? 'Bu kaydın orijinal dosyası yok; yeniden okumak için dosyayı yükleyin.' : (entry.error?.mesaj ?? 'Dosya alınamadı.'), 'err');
      }
      return;
    }
    file = new File([entry.blob], entry.name, { type: entry.type || entry.blob.type });
    byRecord.set(id, file);
  }
  send([file], { force: true });
});

expenseBtn.addEventListener('click', () => {
  if (state.record) navigate('/masraflar/yeni', { query: { fatura: state.record.id } });
});

copyBtn.addEventListener('click', async () => {
  if (!state.record) return;
  const label = copyBtn.querySelector('span');
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.record.body, null, 2));
    label.textContent = 'Kopyalandı';
    setTimeout(() => (label.textContent = 'Kopyala'), 1600);
  } catch {
    toast("Panoya kopyalanamadı; JSON'u indirin.", 'err');
  }
});

downloadBtn.addEventListener('click', () => {
  if (!state.record) return;
  const blob = new Blob([`${JSON.stringify(state.record.body, null, 2)}\n`], { type: 'application/json' });
  const a = el('a', { href: downloadObjectUrl(blob), download: downloadName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
});

function onKey(e) {
  if (e.key === 'Escape' && mobile.matches && state.target !== '' && !document.querySelector('dialog[open]')) closeDetail();
}

// ---------- The view ----------

export const okumaView = {
  mount() {
    active = true;
    outlet.hidden = true;
    section.hidden = false;
    state.pushed = Boolean(history.state?.sheet);
    setFileTarget({ label: 'Bırakın, okumaya başlasın', onFiles: (files) => send(files) });
    window.addEventListener('keydown', onKey);
    routeTarget(true);
    loadHistory();
    return {
      update() {
        state.pushed = Boolean(history.state?.sheet);
        routeTarget();
        return true;
      },
      unmount() {
        active = false;
        if (follow) follow.done = true;
        section.hidden = true;
        section.classList.remove('sheet-open');
        outlet.hidden = false;
        setFileTarget(null);
        window.removeEventListener('keydown', onKey);
      },
    };
  },
};
