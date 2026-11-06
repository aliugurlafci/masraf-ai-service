// Fatura Okuyucu panel. All text is written with textContent / text nodes, never as HTML.

const $ = (id) => document.getElementById(id);
const fileInput = $('file');
const uploadBtn = $('upload');
const sheet = $('sheet');
const statusEl = $('status');
const copyBtn = $('copy');
const downloadBtn = $('download');
const rereadBtn = $('reread');
const metricsEl = $('metrics');
const historyEl = $('history');
const dropHint = $('drop-hint');
const tabs = [...document.querySelectorAll('.tab')];

const ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{8}$/;

const state = {
  view: 'fatura', // fatura | json | orijinal
  phase: 'empty', // empty | reading | done | error
  invoice: null,
  id: null,
  reused: false, // the server returned the stored result of an identical file
  file: null, // last uploaded File, for retry and the original preview
  fileUrl: null,
  fileUrlFor: null, // record id the original preview belongs to
  error: null,
  startedAt: 0,
  timer: null,
  elapsedEl: null,
  animate: false,
  items: [],
};

// ---------- Small DOM helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function svgIcon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', kind === 'ok' ? 'M4 10.5l4 4 8-9' : 'M10 3.5l7 13H3zM10 8.5v3.5M10 14.6v.1');
  svg.append(path);
  return svg;
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---------- Formatting ----------

// Show amounts with the precision the invoice printed (some print 3 decimals, e.g. 942,599); never round them away.
const money2 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const plain = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 4 });
const dayFmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });

const fmtAmount = (v) => (v === null || v === undefined ? null : money2.format(v));
const fmtMoney = (v, cur) => (v === null || v === undefined ? null : `${money2.format(v)} ${cur ?? ''}`.trim());
const fmtQty = (v) => (v === null || v === undefined ? null : plain.format(v));
const fmtRate = (v) => (v === null || v === undefined ? null : `%${plain.format(v)}`);
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : null);

const count = new Intl.NumberFormat('tr-TR');
const usd = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const fmtSeconds = (ms) => `${(ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn`;
const fmtRequest = (ms) => (ms < 1000 ? `${ms} ms` : fmtSeconds(ms));

function value(tag, className, text, missing = 'Bulunamadı') {
  return text === null || text === undefined || text === ''
    ? el(tag, { className }, el('span', { className: 'missing', text: missing }))
    : el(tag, { className, text });
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Bugün';
  if (date.toDateString() === yesterday.toDateString()) return 'Dün';
  return dayFmt.format(date);
}

// ---------- Total checks (help the user spot a misread number) ----------

function totalChecks(inv) {
  const f = inv.fatura;
  const lines = inv.kalemler;
  const out = [];
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.05, lines.length * 0.01);
  const cur = f.paraBirimi;

  if (lines.length === 0) {
    out.push({ ok: false, text: 'Faturada kalem bulunamadı. Orijinal dosyayla karşılaştırın.' });
  } else if (lines.every((l) => l.tutar !== null) && f.araToplam !== null) {
    const sum = lines.reduce((acc, l) => acc + l.tutar, 0);
    if (near(sum, f.araToplam)) {
      out.push({ ok: true, text: 'Kalemlerin toplamı ara toplamla aynı.' });
    } else if (f.genelToplam !== null && near(sum, f.genelToplam)) {
      out.push({ ok: true, text: 'Kalem tutarları KDV dahil; toplamları genel toplamla aynı.' });
    } else {
      out.push({
        ok: false,
        text: `Kalemlerin toplamı ${fmtMoney(sum, cur)}, ara toplam ${fmtMoney(f.araToplam, cur)}. İskonto ya da okunamayan bir kalem olabilir; orijinal dosyayla karşılaştırın.`,
      });
    }
  }

  if (f.araToplam !== null && f.kdvToplam !== null && f.genelToplam !== null) {
    const expected = f.araToplam + f.kdvToplam;
    if (near(expected, f.genelToplam)) {
      out.push({ ok: true, text: 'Ara toplam ile KDV toplamı genel toplama eşit.' });
    } else {
      out.push({
        ok: false,
        text: `Ara toplam ile KDV ${fmtMoney(expected, cur)} ediyor, genel toplam ${fmtMoney(f.genelToplam, cur)}. Tevkifat, stopaj ya da başka bir vergi olabilir.`,
      });
    }
  }
  return out;
}

// ---------- Sheet contents ----------

function invoiceView(inv, animate) {
  const f = inv.fatura;
  const cur = f.paraBirimi;
  let order = 0;
  const print = (node) => {
    if (animate) {
      node.classList.add('print');
      node.style.setProperty('--i', String(order++));
    }
    return node;
  };
  const withCur = (label) => (cur ? `${label} (${cur})` : label);

  const head = print(
    el(
      'header',
      { className: 'doc-head' },
      el(
        'div',
        {},
        el('span', { className: 'label', text: 'Fatura no' }),
        f.faturaNo
          ? el('p', { className: 'doc-no', text: f.faturaNo })
          : el('p', { className: 'doc-no unknown', text: 'Faturada numara bulunamadı' }),
      ),
      el(
        'dl',
        { className: 'doc-meta' },
        el('div', {}, el('dt', { className: 'label', text: 'Tarih' }), value('dd', '', fmtDate(f.faturaTarihi))),
        el('div', {}, el('dt', { className: 'label', text: 'Para birimi' }), value('dd', '', cur)),
      ),
    ),
  );

  const party = (label, name, taxNo) =>
    el(
      'section',
      { className: 'party' },
      el('span', { className: 'label', text: label }),
      value('p', 'name', name),
      taxNo
        ? el('p', { className: 'tax', text: `Vergi no ${taxNo}` })
        : el('p', { className: 'tax' }, el('span', { className: 'missing', text: 'Vergi no bulunamadı' })),
    );

  const parties = print(
    el(
      'div',
      { className: 'parties' },
      party('Satıcı', f.saticiUnvan, f.saticiVergiNo),
      party('Alıcı', f.aliciUnvan, f.aliciVergiNo),
    ),
  );

  const cell = (text, className) =>
    text === null || text === undefined
      ? el('td', { className }, el('span', { className: 'missing', text: '—', 'aria-label': 'yok' }))
      : el('td', { className, text });

  const tbody = el('tbody');
  if (inv.kalemler.length === 0) {
    tbody.append(el('tr', { className: 'no-lines' }, el('td', { colspan: 6, text: 'Kalem bulunamadı.' })));
  }
  for (const line of inv.kalemler) {
    tbody.append(
      print(
        el(
          'tr',
          {},
          cell(line.aciklama, 'desc'),
          cell(fmtQty(line.miktar), 'num'),
          cell(line.birim),
          cell(fmtAmount(line.birimFiyat), 'num'),
          cell(fmtRate(line.kdvOrani), 'num'),
          cell(fmtAmount(line.tutar), 'num'),
        ),
      ),
    );
  }

  const table = el(
    'div',
    { className: 'table-wrap' },
    el(
      'table',
      { className: 'lines' },
      el('caption', { className: 'visually-hidden', text: 'Fatura kalemleri' }),
      el(
        'thead',
        {},
        print(
          el(
            'tr',
            {},
            el('th', { scope: 'col', text: 'Açıklama' }),
            el('th', { scope: 'col', className: 'num', text: 'Miktar' }),
            el('th', { scope: 'col', text: 'Birim' }),
            el('th', { scope: 'col', className: 'num', text: withCur('Birim fiyat') }),
            el('th', { scope: 'col', className: 'num', text: 'KDV' }),
            el('th', { scope: 'col', className: 'num', text: withCur('Tutar') }),
          ),
        ),
      ),
      tbody,
    ),
  );

  const checks = el('ul', { className: 'checks', 'aria-label': 'Toplam kontrolleri' });
  for (const c of totalChecks(inv)) {
    checks.append(el('li', { className: c.ok ? 'ok' : 'warn' }, svgIcon(c.ok ? 'ok' : 'warn'), el('span', { text: c.text })));
  }

  const total = (label, v, className) =>
    el('div', { className }, el('dt', { text: label }), value('dd', '', fmtMoney(v, cur)));

  const summary = print(
    el(
      'div',
      { className: 'summary' },
      checks,
      el(
        'dl',
        { className: 'totals' },
        total('Ara toplam', f.araToplam),
        total('KDV', f.kdvToplam),
        total('Genel toplam', f.genelToplam, 'grand'),
      ),
    ),
  );

  return [head, parties, table, summary];
}

// ---------- Measurements ----------

function metricsView(olcum) {
  const o = olcum.okuma;
  let source;
  if (olcum.kaynak === 'claude') {
    source = `Bu fatura şimdi Claude ile okundu; istek ${fmtRequest(olcum.istekSuresiMs)} sürdü.`;
  } else if (o) {
    source = `Bu istekte Claude çalışmadı, sonuç kayıttan ${fmtRequest(olcum.istekSuresiMs)} içinde geldi. Aşağıdaki değerler faturanın ilk okunuşuna ait.`;
  } else {
    source = 'Bu kayıt, ölçüm eklenmeden önce okunmuş; ölçüm bilgisi yok.';
  }

  const nodes = [el('h2', { id: 'metrics-title', text: 'Ölçüm' }), el('p', { className: 'source', text: source })];
  if (!o) return nodes;

  const item = (label, main, note) =>
    el('div', {}, el('dt', { text: label }), el('dd', {}, main, note ? el('span', { className: 'note', text: note }) : null));

  const tokens = [o.girdiToken, o.onbellektenToken, o.onbellegeToken].filter((v) => v !== null);
  const inputTotal = tokens.reduce((a, b) => a + b, 0);
  let inputNote = null;
  if (o.onbellektenToken) inputNote = `${count.format(o.onbellektenToken)} token önbellekten`;
  else if (tokens.length > 0) inputNote = 'Önbellek kullanılmadı';

  const steps = o.adimlar ?? [];
  let timeNote = o.apiSureMs !== null ? `${fmtSeconds(o.apiSureMs)} modelde` : null;
  if (steps.length > 1) timeNote = `${count.format(steps.length)} okumanın toplamı`;

  const items = [
    item('Okuma süresi', fmtSeconds(o.sureMs), timeNote),
    item('Model turu', o.tur !== null ? count.format(o.tur) : 'Bilinmiyor', null),
    item('Girdi', tokens.length > 0 ? `${count.format(inputTotal)} token` : 'Bilinmiyor', inputNote),
    item('Çıktı', o.ciktiToken !== null ? `${count.format(o.ciktiToken)} token` : 'Bilinmiyor', null),
    item('Model', o.model, `Düşünme düzeyi: ${o.effort ?? 'varsayılan'}`),
  ];
  if (o.apiEsdegeriUsd !== null) {
    items.push(item('API ile olsaydı', usd.format(o.apiEsdegeriUsd), 'Aboneliğe ek ücret yansımaz'));
  }
  nodes.push(el('dl', {}, ...items));

  // Cascade: the cheaper model read first; the next one read only when the checks found a problem.
  if (steps.length > 1) {
    const list = el('ol', { className: 'steps', 'aria-labelledby': 'steps-title' });
    for (const s of steps) {
      let outcome;
      if (s.hata !== null) outcome = `Okunamadı: ${s.hata}`;
      else if (s.sorunlar.length > 0) outcome = `Kontrolden geçmedi: ${s.sorunlar.join(' ')}`;
      else outcome = 'Kontrollerden geçti.';
      if (s.kullanildi) outcome += ' Sonuç bu okumadan.';
      list.append(
        el('li', { className: s.kullanildi ? 'used' : '' }, el('span', { className: 'step-model', text: `${s.model}, ${fmtSeconds(s.sureMs)}` }), el('span', { text: outcome })),
      );
    }
    nodes.push(el('h3', { id: 'steps-title', text: 'Okuma adımları' }), list);
  }
  return nodes;
}

function jsonView(inv) {
  const text = JSON.stringify(inv, null, 2);
  const pre = el('pre', { className: 'json' });
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let last = 0;
  for (const m of text.matchAll(token)) {
    if (m.index > last) pre.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      pre.append(el('span', { className: m[2] ? 'k' : 's', text: m[1] }));
      if (m[2]) pre.append(m[2]);
    } else if (m[3] !== undefined) {
      pre.append(el('span', { className: 'n', text: m[3] }));
    } else {
      pre.append(el('span', { className: 'z', text: m[4] }));
    }
    last = m.index + m[0].length;
  }
  pre.append(text.slice(last));
  return [pre];
}

function originalView() {
  const name = state.file?.name ?? 'fatura';
  if (state.file?.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    return [el('iframe', { className: 'original', src: state.fileUrl, title: `Orijinal dosya: ${name}` })];
  }
  return [el('img', { className: 'original', src: state.fileUrl, alt: `Orijinal dosya: ${name}` })];
}

function emptyView() {
  return [
    el(
      'div',
      { className: 'notice' },
      el('h2', { text: 'Faturayı bu sayfaya bırakın' }),
      el('p', { text: 'PDF, PNG, JPEG, WEBP ya da GIF olabilir. Ekran görüntüsünü Ctrl+V ile de yapıştırabilirsiniz.' }),
      el('p', { text: 'Claude faturayı okur; fatura bilgileri ve kalemler burada, JSON hali yandaki sekmede görünür.' }),
      el('div', { className: 'buttons' }, el('button', { className: 'btn btn-primary', type: 'button', 'data-action': 'pick', text: 'Dosya seç' })),
    ),
  ];
}

function readingView() {
  state.elapsedEl = el('p', { className: 'elapsed', text: elapsedText() });
  return [
    el(
      'div',
      { className: 'notice' },
      el('h2', { text: `${state.file?.name ?? 'Fatura'} okunuyor` }),
      state.elapsedEl,
      el('p', { text: 'Bu bir dakika kadar sürebilir. Sayfayı kapatsanız da sonuç geçmişe kaydedilir.' }),
    ),
  ];
}

function errorView() {
  const { kod, mesaj } = state.error ?? {};
  return [
    el(
      'div',
      { className: 'notice error' },
      el('h2', { text: 'Fatura okunamadı' }),
      el('p', { text: mesaj ?? 'Bilinmeyen bir hata oluştu.' }),
      kod ? el('p', {}, 'Hata kodu: ', el('span', { className: 'code', text: kod })) : null,
      el(
        'div',
        { className: 'buttons' },
        state.file ? el('button', { className: 'btn btn-primary', type: 'button', 'data-action': 'retry', text: 'Tekrar dene' }) : null,
        el('button', { className: 'btn', type: 'button', 'data-action': 'pick', text: 'Başka dosya seç' }),
      ),
    ),
  ];
}

function elapsedText() {
  return `${Math.floor((Date.now() - state.startedAt) / 1000)} sn`;
}

// ---------- Render ----------

function render() {
  const hasInvoice = state.phase === 'done' && state.invoice !== null;
  const hasOriginal = state.fileUrl !== null && (state.phase !== 'done' || state.fileUrlFor === state.id);

  if (state.view === 'json' && !hasInvoice) state.view = 'fatura';
  if (state.view === 'orijinal' && !hasOriginal) state.view = 'fatura';

  for (const tab of tabs) {
    const view = tab.dataset.view;
    if (view === 'json') tab.disabled = !hasInvoice;
    if (view === 'orijinal') tab.hidden = !hasOriginal;
    const selected = view === state.view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  sheet.setAttribute('aria-labelledby', `tab-${state.view}`);

  copyBtn.disabled = !hasInvoice;
  downloadBtn.disabled = !hasInvoice;
  rereadBtn.hidden = !(hasInvoice && state.reused && state.file !== null && state.fileUrlFor === state.id);
  uploadBtn.disabled = state.phase === 'reading';
  uploadBtn.textContent = state.phase === 'reading' ? 'Okunuyor…' : 'Fatura yükle';

  let content;
  if (state.view === 'orijinal') content = originalView();
  else if (state.view === 'json') content = jsonView(state.invoice);
  else if (state.phase === 'reading') content = readingView();
  else if (state.phase === 'error') content = errorView();
  else if (state.phase === 'done') content = invoiceView(state.invoice, state.animate);
  else content = emptyView();

  sheet.dataset.state = state.view === 'fatura' ? state.phase : 'plain';
  sheet.replaceChildren(...content);

  const olcum = hasInvoice ? state.invoice.olcum : undefined;
  metricsEl.hidden = !olcum;
  metricsEl.replaceChildren(...(olcum ? metricsView(olcum) : []));
  state.animate = false; // the print-in happens once, right after a fresh reading
  renderHistory();
}

function renderHistory() {
  historyEl.replaceChildren();
  if (state.items.length === 0) {
    historyEl.append(el('p', { className: 'empty', text: 'Okuduğunuz faturalar burada listelenir.' }));
    return;
  }
  let currentDay = '';
  let list = null;
  for (const item of state.items) {
    const date = new Date(item.olusturulma);
    const day = dayLabel(date);
    if (day !== currentDay) {
      currentDay = day;
      list = el('ul');
      historyEl.append(el('h3', { className: 'day', text: day }), list);
    }
    const who = item.saticiUnvan ?? item.dosyaAdi;
    const no = item.faturaNo ?? (item.saticiUnvan ? item.dosyaAdi : 'Fatura no yok');
    const btn = el(
      'button',
      {
        className: 'history-item',
        type: 'button',
        'data-id': item.id,
        'aria-current': item.id === state.id ? 'true' : null,
        title: `${item.dosyaAdi}, ${dayFmt.format(date)} ${timeFmt.format(date)}`,
      },
      el('span', { className: 'who', text: who }),
      el('span', { className: 'no', text: no }),
      el('span', { className: 'sum', text: fmtMoney(item.genelToplam, item.paraBirimi) ?? '' }),
    );
    list.append(el('li', {}, btn));
  }
}

// ---------- Actions ----------

async function loadHistory() {
  try {
    const res = await fetch('/api/invoices');
    if (res.ok) state.items = await res.json();
  } catch {
    // The status line already reports connection problems for uploads.
  }
  renderHistory();
}

function setHash(id) {
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
}

async function openRecord(id) {
  if (state.phase === 'reading' || !ID_PATTERN.test(id)) return;
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(id)}`);
    if (!res.ok) {
      setStatus('Bu kayıt bulunamadı.');
      return;
    }
    state.invoice = await res.json();
    state.id = id;
    state.reused = false;
    state.phase = 'done';
    state.error = null;
    setHash(id);
    const meta = state.items.find((i) => i.id === id);
    if (meta) {
      const date = new Date(meta.olusturulma);
      setStatus(`${meta.dosyaAdi}, ${dayFmt.format(date)} ${timeFmt.format(date)}`);
    } else {
      setStatus('');
    }
    render();
  } catch {
    setStatus('Sunucuya ulaşılamadı. Servisin çalıştığından emin olun (npm start).');
  }
}

async function upload(file, force = false) {
  if (!file) return;
  if (state.phase === 'reading') {
    setStatus('Şu anki fatura okunuyor; bitince yeni dosyayı bırakın.');
    return;
  }
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.file = file;
  state.fileUrl = URL.createObjectURL(file);
  state.fileUrlFor = null;
  state.phase = 'reading';
  state.error = null;
  state.view = 'fatura';
  state.startedAt = Date.now();
  setStatus('');
  render();
  state.timer = setInterval(() => {
    if (state.elapsedEl) state.elapsedEl.textContent = elapsedText();
  }, 1000);

  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(force ? '/api/invoices?yenile=1' : '/api/invoices', { method: 'POST', body: form });
    const body = await res.json().catch(() => null);
    if (res.ok && body) {
      state.invoice = body;
      state.id = res.headers.get('X-Fatura-Id');
      state.reused = res.headers.get('X-Fatura-Onbellek') === '1';
      state.fileUrlFor = state.id;
      state.phase = 'done';
      state.animate = true;
      if (state.id) setHash(state.id);
      const seconds = Math.round((Date.now() - state.startedAt) / 1000);
      setStatus(
        state.reused
          ? `${file.name} daha önce okunmuş; kayıtlı sonuç gösteriliyor.`
          : `${file.name} okundu: ${body.kalemler.length} kalem, ${seconds} sn.`,
      );
    } else {
      state.phase = 'error';
      state.error = {
        kod: body?.hata?.kod ?? `http_${res.status}`,
        mesaj: body?.hata?.mesaj ?? `Sunucu ${res.status} durum koduyla yanıt verdi.`,
      };
      setStatus('Fatura okunamadı.');
    }
  } catch {
    state.phase = 'error';
    state.error = { kod: 'baglanti', mesaj: 'Sunucuya ulaşılamadı. Servisin çalıştığından emin olun (npm start).' };
    setStatus('Fatura okunamadı.');
  } finally {
    clearInterval(state.timer);
    state.elapsedEl = null;
    render();
    await loadHistory();
  }
}

function downloadName() {
  const base = state.invoice?.fatura?.faturaNo ?? state.id ?? 'fatura';
  return `fatura-${String(base).replace(/[^\w.-]+/g, '_')}.json`;
}

// ---------- Events ----------

uploadBtn.addEventListener('click', () => fileInput.click());
rereadBtn.addEventListener('click', () => upload(state.file, true));

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = ''; // allow choosing the same file again
  upload(file);
});

sheet.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'pick') fileInput.click();
  if (action === 'retry') upload(state.file);
});

historyEl.addEventListener('click', (e) => {
  const id = e.target.closest('.history-item')?.dataset.id;
  if (id) openRecord(id);
});

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    render();
  });
}

document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const usable = tabs.filter((t) => !t.hidden && !t.disabled);
  const index = usable.findIndex((t) => t.dataset.view === state.view);
  const next = usable[(index + (e.key === 'ArrowRight' ? 1 : usable.length - 1)) % usable.length];
  if (!next) return;
  e.preventDefault();
  state.view = next.dataset.view;
  render();
  next.focus();
});

copyBtn.addEventListener('click', async () => {
  if (!state.invoice) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.invoice, null, 2));
    copyBtn.textContent = 'Kopyalandı';
    setTimeout(() => (copyBtn.textContent = "JSON'u kopyala"), 1600);
  } catch {
    setStatus("Panoya kopyalanamadı; JSON'u indirin.");
  }
});

downloadBtn.addEventListener('click', () => {
  if (!state.invoice) return;
  const blob = new Blob([`${JSON.stringify(state.invoice, null, 2)}\n`], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: downloadName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
});

// Drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  dropHint.hidden = false;
  sheet.classList.add('dropping');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropHint.hidden = true;
    sheet.classList.remove('dropping');
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropHint.hidden = true;
  sheet.classList.remove('dropping');
  upload(e.dataTransfer.files[0]);
});

// Paste a screenshot of an invoice.
window.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files ?? [])][0];
  if (file) {
    e.preventDefault();
    upload(file);
  }
});

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id !== state.id) openRecord(id);
});

// ---------- Start ----------

render();
loadHistory().then(() => {
  const id = location.hash.slice(1);
  if (ID_PATTERN.test(id)) openRecord(id);
});
