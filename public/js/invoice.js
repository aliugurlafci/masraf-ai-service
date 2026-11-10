// Detail pane contents: the invoice as a document, its measurements, JSON, the original file,
// and the states around them (empty, loading, reading, error).

import { el, icon, ICONS } from './dom.js';
import { safeType } from './files.js';
import {
  fmtAmount,
  fmtCount,
  fmtDate,
  fmtDay,
  fmtElapsed,
  fmtMoney,
  fmtQty,
  fmtRate,
  fmtRequest,
  fmtSeconds,
  fmtTime,
  fmtUsd,
  modelName,
  queueText,
} from './format.js';

function value(tag, className, text, missing = 'Bulunamadı') {
  return text === null || text === undefined || text === ''
    ? el(tag, { className }, el('span', { className: 'missing', text: missing }))
    : el(tag, { className, text });
}

// ---------- Total checks (help the user spot a misread number) ----------
// Kept in step with the server's own checks in src/invoice/checks.ts.

export function totalChecks(inv) {
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

// ---------- The invoice as a document ----------

export function invoiceView(inv, { fresh = false } = {}) {
  const f = inv.fatura;
  const cur = f.paraBirimi;
  const withCur = (label) => (cur ? `${label} (${cur})` : label);

  const head = el(
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

  const parties = el('div', { className: 'parties' }, party('Satıcı', f.saticiUnvan, f.saticiVergiNo), party('Alıcı', f.aliciUnvan, f.aliciVergiNo));

  const cell = (text, className, label) =>
    text === null || text === undefined
      ? el('td', { className, 'data-label': label }, el('span', { className: 'missing', text: '—', 'aria-label': 'yok' }))
      : el('td', { className, 'data-label': label, text });

  const tbody = el('tbody');
  if (inv.kalemler.length === 0) {
    tbody.append(el('tr', { className: 'no-lines' }, el('td', { colspan: 6, text: 'Kalem bulunamadı.' })));
  }
  for (const line of inv.kalemler) {
    tbody.append(
      el(
        'tr',
        {},
        cell(line.aciklama, 'desc'),
        cell(fmtQty(line.miktar), 'num', 'Miktar'),
        cell(line.birim, '', 'Birim'),
        cell(fmtAmount(line.birimFiyat), 'num', 'Birim fiyat'),
        cell(fmtRate(line.kdvOrani), 'num', 'KDV'),
        cell(fmtAmount(line.tutar), 'num amount'),
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
      tbody,
    ),
  );

  const checks = el('ul', { className: 'checks', 'aria-label': 'Toplam kontrolleri' });
  for (const c of totalChecks(inv)) {
    checks.append(el('li', { className: c.ok ? 'ok' : 'warn' }, icon(c.ok ? ICONS.check : ICONS.warn), el('span', { text: c.text })));
  }

  const total = (label, v, className) => el('div', { className }, el('dt', { text: label }), value('dd', '', fmtMoney(v, cur)));
  const summary = el(
    'div',
    { className: 'summary' },
    checks,
    el('dl', { className: 'totals' }, total('Ara toplam', f.araToplam), total('KDV', f.kdvToplam), total('Genel toplam', f.genelToplam, 'grand')),
  );

  return el('article', { className: fresh ? 'doc fresh' : 'doc', 'aria-label': 'Fatura' }, head, parties, table, summary);
}

// ---------- Measurements ----------

/**
 * Where the numbers come from. `activity` is this server's live record of the read (when the file
 * was read since the server started); `savedAt` is the record's date from the list.
 */
function sourceText(olcum, activity, savedAt) {
  if (!olcum.okuma) return 'Bu kayıt, ölçüm eklenmeden önce okunmuş; ölçüm bilgisi yok.';
  if (activity && !activity.onbellek && activity.bitis) {
    const waited = activity.baslama ? Date.parse(activity.baslama) - Date.parse(activity.alinma) : 0;
    const queue = waited >= 1000 ? `; okunmadan önce ${fmtElapsed(waited)} sırada bekledi` : '';
    return `Bu fatura saat ${fmtTime(activity.bitis)} itibarıyla Claude ile okundu${queue}.`;
  }
  if (activity?.onbellek) return 'Bu dosya daha önce okunmuştu; Claude yeniden çalışmadı. Aşağıdaki değerler ilk okunuşa ait.';
  if (olcum.kaynak === 'claude') return `Bu fatura şimdi Claude ile okundu; istek ${fmtRequest(olcum.istekSuresiMs)} sürdü.`;
  if (savedAt) {
    const d = new Date(savedAt);
    return `Kayıttan açıldı. Aşağıdaki değerler faturanın ${fmtDay(d)} ${fmtTime(savedAt)} tarihindeki okunuşuna ait.`;
  }
  return 'Kayıttan açıldı. Aşağıdaki değerler faturanın ilk okunuşuna ait.';
}

export function metricsView(olcum, { activity = null, savedAt = null } = {}) {
  const section = el('section', { className: 'metrics', 'aria-labelledby': 'metrics-title' });
  section.append(el('h2', { id: 'metrics-title', text: 'Ölçüm' }), el('p', { className: 'source-note', text: sourceText(olcum, activity, savedAt) }));
  const o = olcum.okuma;
  if (!o) return section;

  const item = (label, main, note) =>
    el('div', {}, el('dt', { text: label }), el('dd', {}, main, note ? el('span', { className: 'note', text: note }) : null));

  const tokens = [o.girdiToken, o.onbellektenToken, o.onbellegeToken].filter((v) => v !== null);
  const inputTotal = tokens.reduce((a, b) => a + b, 0);
  let inputNote = null;
  if (o.onbellektenToken) inputNote = `${fmtCount(o.onbellektenToken)} token önbellekten`;
  else if (tokens.length > 0) inputNote = 'Önbellek kullanılmadı';

  const steps = o.adimlar ?? [];
  let timeNote = o.apiSureMs !== null ? `${fmtSeconds(o.apiSureMs)} modelde` : null;
  if (steps.length > 1) timeNote = `${fmtCount(steps.length)} okumanın toplamı`;

  const items = [
    item('Okuma süresi', fmtSeconds(o.sureMs), timeNote),
    item('Model turu', o.tur !== null ? fmtCount(o.tur) : 'Bilinmiyor', null),
    item('Girdi', tokens.length > 0 ? `${fmtCount(inputTotal)} token` : 'Bilinmiyor', inputNote),
    item('Çıktı', o.ciktiToken !== null ? `${fmtCount(o.ciktiToken)} token` : 'Bilinmiyor', null),
    item('Model', o.model, `Düşünme düzeyi: ${o.effort ?? 'varsayılan'}`),
  ];
  if (o.apiEsdegeriUsd !== null) items.push(item('API ile olsaydı', fmtUsd(o.apiEsdegeriUsd), 'Aboneliğe ek ücret yansımaz'));
  section.append(el('dl', {}, ...items));

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
        el(
          'li',
          { className: s.kullanildi ? 'used' : '' },
          el('span', { className: 'step-model', text: `${s.model}, ${fmtSeconds(s.sureMs)}` }),
          el('span', { text: outcome }),
        ),
      );
    }
    section.append(el('h3', { id: 'steps-title', text: 'Okuma adımları' }), list);
  }
  return section;
}

// ---------- JSON and the original file ----------

export function jsonView(inv) {
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
  return pre;
}

/** file: { name, type }, where type is the URL's own (safe) type; only PDF and invoice images are shown. */
export function originalView(file, url) {
  const name = file.name || 'fatura';
  const type = safeType(file.type);
  if (type === 'application/pdf') {
    return el('iframe', { className: 'original', src: url, title: `Orijinal dosya: ${name}` });
  }
  if (type.startsWith('image/')) return el('img', { className: 'original', src: url, alt: `Orijinal dosya: ${name}` });
  return el('div', { className: 'notice neutral' }, el('p', { text: 'Bu dosya türü burada gösterilemiyor.' }));
}

// ---------- States around the invoice ----------

export function welcomeView() {
  return el(
    'div',
    { className: 'welcome-wrap' },
    el(
      'div',
      { className: 'welcome' },
      el('span', { className: 'sheet-glyph large', 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
      el('h2', { text: 'Faturaları buraya bırakın' }),
      el('p', { text: 'PDF, PNG, JPEG, WEBP ya da GIF olabilir. Birden fazla dosya seçebilir, ekran görüntüsünü Ctrl+V ile yapıştırabilirsiniz.' }),
      el('button', { className: 'btn btn-primary', type: 'button', 'data-action': 'pick', text: 'Dosya seç' }),
    ),
    el(
      'div',
      { className: 'api-hint' },
      el('p', { text: 'Başka programların API ile gönderdiği faturalar da soldaki akışta canlı görünür:' }),
      el('p', {}, el('code', { text: 'POST /api/invoices' }), ' tek dosya, ', el('code', { text: 'POST /api/invoices/toplu' }), ' birden fazla dosya.'),
    ),
  );
}

export function loadingView() {
  return el('div', { className: 'skeleton', 'aria-label': 'Kayıt yükleniyor', role: 'status' }, el('span'), el('span'), el('span'), el('span'));
}

/** A file that is still waiting or being read; the clock ticks through data-since. */
export function readingView(a) {
  const reading = a.durum === 'okunuyor';
  let status;
  if (!reading) {
    status = Number.isInteger(a.kuyrukSirasi)
      ? `${queueText(a.kuyrukSirasi, a.onundeki)}. Sırası gelince okunmaya başlayacak.`
      : 'Sırada. Boş bir okuma hattı açılınca başlayacak.';
  }
  else if (!a.model) status = 'Claude başlıyor.';
  else if (a.modeller.length > 1) status = `Kontroller tutmadı; ${modelName(a.model)} yeniden okuyor.`;
  else status = `${modelName(a.model)} okuyor.`;

  return el(
    'div',
    { className: 'welcome reading', role: 'status' },
    el('span', { className: `sheet-glyph large${reading ? ' active' : ''}`, 'aria-hidden': 'true' }, el('span', { className: 'scan' })),
    el('h2', { text: a.dosyaAdi }),
    el('p', { text: status }),
    el('p', { className: 'reading-clock', 'data-since': reading ? a.baslama : a.alinma, 'data-fmt': 'elapsed', text: '' }),
    el('p', { className: 'reading-note', text: 'Sayfayı kapatsanız da okuma sürer; sonuç kayıtlara yazılır.' }),
  );
}

export function errorView(error, { canRetry, title = 'Fatura okunamadı' }) {
  return el(
    'div',
    { className: 'notice' },
    el('h2', { text: title }),
    el('p', { text: error?.mesaj ?? 'Bilinmeyen bir hata oluştu.' }),
    error?.kod ? el('p', {}, 'Hata kodu: ', el('span', { className: 'code', text: error.kod })) : null,
    el(
      'div',
      { className: 'buttons' },
      canRetry ? el('button', { className: 'btn btn-primary', type: 'button', 'data-action': 'retry', text: 'Tekrar dene' }) : null,
      el('button', { className: 'btn', type: 'button', 'data-action': 'pick', text: 'Başka dosya seç' }),
    ),
  );
}
