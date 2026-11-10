// The live monitor: reading lanes, the waiting line, the activity feed, server-wide counters and
// the older records. It mirrors the server's activity log and redraws only what changed.

import { el, icon, ICONS, replay } from './dom.js';
import { dayLabel, fmtClock, fmtCount, fmtDay, fmtMoney, fmtTime, fmtUsdShort, modelName, queueText } from './format.js';
import { READ_SOURCE } from './labels.js';

const FLASH_MS = 1400;
const FEED_LIMIT = 200;
const KEEP = 300;

const FINISHED = new Set(['bitti', 'hata']);
const FILTERS = {
  tumu: () => true,
  suren: (a) => !FINISHED.has(a.durum),
  hata: (a) => a.durum === 'hata',
};
const EMPTY_TEXT = {
  tumu: 'Sunucu açıldığından beri dosya gelmedi. Panelden ya da API ile gönderilen her fatura burada canlı görünür.',
  suren: 'Şu an okunan ya da sırada bekleyen dosya yok.',
  hata: 'Okunamayan dosya yok.',
};

// kaynak: panel | api | arka_plan (a read the server started itself: pending invoices after a
// restart, or "Yeniden oku" on an expense). Anything unknown is shown as the panel was.
const sourceKey = (a) => (READ_SOURCE[a.kaynak] ? a.kaynak : 'panel');
const sourceChip = (a) => el('span', { className: `source ${sourceKey(a)}`, text: READ_SOURCE[sourceKey(a)] });

function glyph(a) {
  if (a.durum === 'sirada') return el('span', { className: 'glyph sirada', 'aria-hidden': 'true' }, icon(ICONS.clock));
  if (a.durum === 'okunuyor') return el('span', { className: 'glyph okunuyor', 'aria-hidden': 'true' });
  if (a.durum === 'hata') return el('span', { className: 'glyph hata', 'aria-hidden': 'true' }, icon(ICONS.alert));
  return el('span', { className: `glyph ${a.onbellek ? 'kayit' : 'bitti'}`, 'aria-hidden': 'true' }, icon(a.onbellek ? ICONS.stack : ICONS.check));
}

const STATE_LABEL = { sirada: 'Sırada', okunuyor: 'Okunuyor', bitti: 'Okundu', hata: 'Okunamadı' };

function readingText(a) {
  if (!a.model) return 'Okuma başlıyor';
  if (a.modeller.length > 1) return `Kontroller tutmadı, ${modelName(a.model)} yeniden okuyor`;
  return `${modelName(a.model)} okuyor`;
}

/** "Sırada 3. · önünde 4 fatura var" when the server knows the place; otherwise the old wording. */
function waitingText(a) {
  return Number.isInteger(a.kuyrukSirasi) ? queueText(a.kuyrukSirasi, a.onundeki) : 'Sırada, boş hat bekliyor';
}

function subText(a) {
  if (a.durum === 'sirada') return waitingText(a);
  if (a.durum === 'okunuyor') return readingText(a);
  if (a.durum === 'hata') return a.hata?.mesaj ?? 'Okunamadı';
  const o = a.ozet;
  const no = o?.faturaNo ?? (o?.saticiUnvan ? a.dosyaAdi : 'Fatura no yok');
  return `${no}, ${a.onbellek ? 'daha önce okunmuş' : `${fmtCount(o?.kalemSayisi ?? 0)} kalem`}`;
}

function timeNode(a) {
  if (a.durum === 'sirada') return el('span', { 'data-since': a.alinma, 'data-fmt': 'elapsed' });
  if (a.durum === 'okunuyor') return el('span', { 'data-since': a.baslama ?? a.alinma, 'data-fmt': 'elapsed' });
  return el('span', { text: fmtTime(a.bitis ?? a.alinma) });
}

export function createMonitor(els, { canRetry }) {
  const activities = new Map(); // id -> activity
  let order = []; // ids, newest first
  let stats = null;
  let records = [];
  let filter = 'tumu';
  let ready = false;
  let current = { activityId: null, recordId: null };

  const rows = new Map(); // id -> { li, sig }
  const entering = new Set();
  const flashing = new Map(); // id -> 'flash' | 'flash-err'
  let slots = []; // lane index -> { id, until, fresh, sig } | null
  let laneTimer = null;
  const statNodes = new Map();

  // ---------- State ----------

  function applySnapshot(snapshot) {
    activities.clear();
    for (const a of snapshot.etkinlikler) activities.set(a.id, a);
    order = snapshot.etkinlikler.map((a) => a.id);
    stats = snapshot.istatistik;
    // A fresh picture (first load or after a reconnect): nothing animates in.
    slots = slots.map((s) => (s && activities.get(s.id)?.durum === 'okunuyor' ? s : null));
    ready = true;
    renderAll();
  }

  /** Returns the activity as it was before this event, or null when it is new. */
  function applyEvent({ etkinlik: a, istatistik }) {
    const before = activities.get(a.id) ?? null;
    activities.set(a.id, a);
    stats = istatistik;
    if (!before) {
      order.unshift(a.id);
      entering.add(a.id);
      prune();
    } else if (!FINISHED.has(before.durum) && FINISHED.has(a.durum)) {
      flashing.set(a.id, a.durum === 'hata' ? 'flash-err' : 'flash');
    }
    renderAll();
    return before;
  }

  function prune() {
    let finished = order.filter((id) => FINISHED.has(activities.get(id)?.durum)).length;
    for (let i = order.length - 1; i >= 0 && finished > KEEP; i--) {
      const id = order[i];
      if (!FINISHED.has(activities.get(id)?.durum)) continue;
      order.splice(i, 1);
      activities.delete(id);
      rows.get(id)?.li.remove();
      rows.delete(id);
      finished--;
    }
  }

  // ---------- Stats in the top bar ----------

  const STAT_DEFS = [
    ['okunuyor', 'Okunuyor', (s) => fmtCount(s.okunuyor)],
    ['sirada', 'Sırada', (s) => fmtCount(s.sirada)],
    ['bitti', 'Okundu', (s) => fmtCount(s.bitti)],
    ['hata', 'Okunamadı', (s) => fmtCount(s.hata)],
    ['kayittan', 'Kayıttan', (s) => fmtCount(s.kayittan)],
    ['usd', 'API karşılığı', (s) => fmtUsdShort(s.apiEsdegeriUsd)],
  ];

  function renderStats() {
    if (!stats) return;
    if (statNodes.size === 0) {
      for (const [key, label] of STAT_DEFS) {
        const dd = el('dd');
        const div = el('div', {}, el('dt', { text: label }), dd);
        statNodes.set(key, { div, dd });
        els.stats.append(div);
      }
    }
    els.stats.title = `Sunucu ${fmtDay(new Date(stats.baslangic))} ${fmtTime(stats.baslangic)} saatinde açıldığından beri`;
    for (const [key, , format] of STAT_DEFS) {
      const { div, dd } = statNodes.get(key);
      const text = format(stats);
      if (dd.textContent !== text) {
        const first = dd.textContent === '';
        dd.textContent = text;
        if (!first) replay(dd, 'bump');
      }
      if (key === 'hata') div.classList.toggle('is-err', stats.hata > 0);
    }
  }

  // ---------- Lanes ----------

  function assignLanes() {
    const now = Date.now();
    const n = Math.max(1, stats?.esZamanli ?? 1);
    slots = slots.slice(0, n);
    while (slots.length < n) slots.push(null);

    const reading = order
      .map((id) => activities.get(id))
      .filter((a) => a?.durum === 'okunuyor')
      .reverse(); // the longest-running first
    const readingIds = new Set(reading.map((a) => a.id));

    slots = slots.map((s) => {
      if (!s || !activities.has(s.id)) return null;
      if (readingIds.has(s.id)) return s;
      if (s.until === 0) return { ...s, until: now + FLASH_MS, fresh: false }; // just finished: show the result briefly
      return s.until > now ? s : null;
    });

    const placed = new Set(slots.filter(Boolean).map((s) => s.id));
    let overflow = 0;
    for (const a of reading) {
      if (placed.has(a.id)) continue;
      let i = slots.findIndex((s) => s === null);
      if (i < 0) i = slots.findIndex((s) => s.until > 0);
      if (i < 0) {
        overflow++;
        continue;
      }
      slots[i] = { id: a.id, until: 0, fresh: ready, sig: '' };
    }

    const nextFlashEnd = Math.min(...slots.filter((s) => s?.until > 0).map((s) => s.until));
    if (Number.isFinite(nextFlashEnd) && laneTimer === null) {
      laneTimer = setTimeout(() => {
        laneTimer = null;
        renderLanes();
      }, nextFlashEnd - now + 30);
    }
    return overflow;
  }

  function laneContent(a, finishing) {
    const glyphNode = el('span', { className: 'sheet-glyph', 'aria-hidden': 'true' }, el('span', { className: 'scan' }));
    if (!a) {
      return {
        state: 'idle',
        nodes: [glyphNode, el('span', { className: 'lane-name', text: 'Boşta' }), el('span', { className: 'lane-time' }), el('span', { className: 'lane-sub' }, el('span', { text: 'Yeni dosya bekleniyor' }))],
      };
    }
    if (finishing && a.durum === 'bitti') {
      const took = a.baslama && a.bitis ? fmtClock(Date.parse(a.bitis) - Date.parse(a.baslama)) : '';
      const total = a.ozet ? fmtMoney(a.ozet.genelToplam, a.ozet.paraBirimi) : null;
      return {
        state: 'done',
        nodes: [
          glyphNode,
          el('span', { className: 'lane-name', text: a.ozet?.saticiUnvan ?? a.dosyaAdi }),
          el('span', { className: 'lane-time', text: took }),
          el('span', { className: 'lane-sub' }, el('span', { text: total ? `Okundu, ${total}` : 'Okundu' })),
        ],
      };
    }
    if (finishing) {
      return {
        state: 'failed',
        nodes: [
          glyphNode,
          el('span', { className: 'lane-name', text: a.dosyaAdi }),
          el('span', { className: 'lane-time' }),
          el('span', { className: 'lane-sub' }, el('span', { text: a.hata?.mesaj ?? 'Okunamadı' })),
        ],
      };
    }
    const chip = el('span', { className: 'model-chip', text: modelName(a.model) ?? 'Başlıyor' });
    return {
      state: 'reading',
      chip,
      nodes: [
        glyphNode,
        el('span', { className: 'lane-name', text: a.dosyaAdi }),
        el('span', { className: 'lane-time', 'data-since': a.baslama ?? a.alinma, 'data-fmt': 'clock', text: fmtClock(Date.now() - Date.parse(a.baslama ?? a.alinma)) }),
        el('span', { className: 'lane-sub' }, chip, sourceChip(a), a.modeller.length > 1 ? el('span', { text: 'yeniden okuyor' }) : null),
      ],
    };
  }

  function renderLanes() {
    if (!stats) return;
    const overflow = assignLanes();
    const list = els.lanes;
    while (list.children.length > slots.length) list.lastElementChild.remove();
    while (list.children.length < slots.length) list.append(el('li'));

    slots.forEach((s, i) => {
      const li = list.children[i];
      const a = s ? activities.get(s.id) : null;
      const finishing = Boolean(s && s.until > 0);
      const sig = a ? `${a.id}|${a.durum}|${a.model}|${finishing}|${current.activityId === a.id}` : 'idle';
      if (li.dataset.sig === sig) return;
      const previousId = li.dataset.activity;
      const previousModel = li.dataset.model;
      li.dataset.sig = sig;
      li.dataset.activity = a?.id ?? '';
      li.dataset.model = a?.model ?? '';

      const { state, nodes, chip } = laneContent(a, finishing);
      const label = a ? `${a.dosyaAdi}: ${finishing ? STATE_LABEL[a.durum] : readingText(a)}` : null;
      const lane = a
        ? el('button', { className: 'lane', type: 'button', 'data-state': state, 'data-activity': a.id, 'aria-label': label, 'aria-current': current.activityId === a.id ? 'true' : null }, ...nodes)
        : el('div', { className: 'lane', 'data-state': state }, ...nodes);
      li.replaceChildren(lane);
      if (a && s.fresh && previousId !== a.id) lane.classList.add('enter');
      if (chip && previousId === a.id && previousModel && previousModel !== (a.model ?? '')) chip.classList.add('swap');
    });

    const busy = slots.filter((s) => s && s.until === 0).length;
    els.lanesMeta.textContent = `${fmtCount(busy)} / ${fmtCount(slots.length)} hat dolu${overflow > 0 ? `, +${fmtCount(overflow)} okuma daha` : ''}`;

    // The line in front of the lanes in reading order (the server's place when known), else oldest first.
    const waiting = order
      .map((id) => activities.get(id))
      .filter((a) => a?.durum === 'sirada')
      .reverse()
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (x.a.kuyrukSirasi ?? Infinity) - (y.a.kuyrukSirasi ?? Infinity) || x.i - y.i)
      .map((x) => x.a);
    els.waiting.hidden = waiting.length === 0;
    if (waiting.length > 0) {
      const names = waiting.slice(0, 3).map((a) => a.dosyaAdi).join(', ');
      const more = waiting.length > 3 ? ` ve ${fmtCount(waiting.length - 3)} dosya daha` : '';
      els.waiting.replaceChildren(el('strong', { text: fmtCount(waiting.length) }), el('span', { text: `sırada: ${names}${more}` }));
    }
  }

  // ---------- Feed ----------

  function rowSig(a) {
    return [a.durum, a.model, a.modeller.length, a.kayitId, a.onbellek, a.hata?.kod, a.kuyrukSirasi, a.onundeki, a.kaynak, current.activityId === a.id, canRetry(a)].join('|');
  }

  function fillRow(entry, a) {
    const focused = entry.li.contains(document.activeElement) ? (document.activeElement.dataset.retry ? 'retry' : 'row') : null;
    const title = a.durum === 'bitti' ? (a.ozet?.saticiUnvan ?? a.dosyaAdi) : a.dosyaAdi;
    const amount = a.durum === 'bitti' && a.ozet ? (fmtMoney(a.ozet.genelToplam, a.ozet.paraBirimi) ?? '') : '';
    const row = el(
      'button',
      {
        className: 'row',
        type: 'button',
        'data-state': a.durum,
        'data-activity': a.id,
        'aria-current': current.activityId === a.id ? 'true' : null,
        title: `${a.dosyaAdi}, ${STATE_LABEL[a.durum].toLowerCase()}${a.hata ? `: ${a.hata.mesaj}` : ''}, geliş ${fmtTime(a.alinma)}`,
      },
      glyph(a),
      el('span', { className: 'row-title', text: title }),
      el('span', { className: 'row-amount', text: amount }),
      el('span', { className: 'row-sub', text: subText(a) }),
      el('span', { className: 'row-meta' }, sourceChip(a), timeNode(a)),
    );
    const retry = canRetry(a)
      ? el('button', { className: 'btn row-retry', type: 'button', 'data-retry': a.id, 'aria-label': `${a.dosyaAdi} dosyasını tekrar gönder`, text: 'Tekrar dene' })
      : null;
    entry.li.replaceChildren(row, retry ?? '');
    if (focused === 'retry' && retry) retry.focus();
    else if (focused) row.focus();
  }

  function renderFeed() {
    const visible = [];
    for (const id of order) {
      const a = activities.get(id);
      if (a && FILTERS[filter](a)) visible.push(a);
      if (visible.length >= FEED_LIMIT) break;
    }

    let cursor = els.feed.firstElementChild;
    for (const a of visible) {
      let entry = rows.get(a.id);
      if (!entry) {
        entry = { li: el('li', { 'data-id': a.id }), sig: '' };
        rows.set(a.id, entry);
      }
      const sig = rowSig(a);
      if (entry.sig !== sig) {
        entry.sig = sig;
        fillRow(entry, a);
      }
      if (entering.has(a.id)) {
        entering.delete(a.id);
        entry.li.classList.add('enter');
        setTimeout(() => entry.li.classList.remove('enter'), 400);
      }
      const flash = flashing.get(a.id);
      if (flash) {
        flashing.delete(a.id);
        replay(entry.li, flash);
        setTimeout(() => entry.li.classList.remove(flash), 1300);
      }
      if (entry.li !== cursor) els.feed.insertBefore(entry.li, cursor);
      else cursor = cursor.nextElementSibling;
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
    entering.clear();
    flashing.clear();

    els.feedEmpty.hidden = !ready || visible.length > 0;
    els.feedEmpty.textContent = EMPTY_TEXT[filter];

    // Counts on the filter buttons.
    let running = 0;
    let failed = 0;
    for (const a of activities.values()) {
      if (!FINISHED.has(a.durum)) running++;
      else if (a.durum === 'hata') failed++;
    }
    for (const button of els.filters.querySelectorAll('button')) {
      const n = button.dataset.filter === 'suren' ? running : button.dataset.filter === 'hata' ? failed : 0;
      let badge = button.querySelector('.count');
      if (n > 0) {
        if (!badge) button.append(' ', (badge = el('span', { className: 'count' })));
        badge.textContent = fmtCount(n);
      } else if (badge) {
        badge.previousSibling?.remove();
        badge.remove();
      }
    }
  }

  // ---------- Older records ----------

  function renderHistory() {
    const inFeed = new Set();
    for (const a of activities.values()) if (a.kayitId) inFeed.add(a.kayitId);
    const older = records.filter((r) => !inFeed.has(r.id));
    const focusedId = els.history.contains(document.activeElement) ? document.activeElement.dataset.record : null;

    if (older.length === 0) {
      els.history.replaceChildren();
      return;
    }
    const nodes = [el('h2', { className: 'history-title', text: inFeed.size > 0 || order.length > 0 ? 'Önceki kayıtlar' : 'Kayıtlar' })];
    let day = '';
    let list = null;
    for (const r of older) {
      const date = new Date(r.olusturulma);
      const label = dayLabel(date);
      if (label !== day) {
        day = label;
        list = el('ul');
        nodes.push(el('h3', { className: 'day', text: label }), list);
      }
      const no = r.faturaNo ?? (r.saticiUnvan ? r.dosyaAdi : 'Fatura no yok');
      list.append(
        el(
          'li',
          {},
          el(
            'button',
            {
              className: 'row',
              type: 'button',
              'data-record': r.id,
              'aria-current': current.recordId === r.id && !current.activityId ? 'true' : null,
              title: `${r.dosyaAdi}, ${fmtDay(date)} ${fmtTime(r.olusturulma)}`,
            },
            el('span', { className: 'glyph gecmis', 'aria-hidden': 'true' }, icon(ICONS.sheet)),
            el('span', { className: 'row-title', text: r.saticiUnvan ?? r.dosyaAdi }),
            el('span', { className: 'row-amount', text: fmtMoney(r.genelToplam, r.paraBirimi) ?? '' }),
            el('span', { className: 'row-sub', text: no }),
            el('span', { className: 'row-meta', text: fmtTime(r.olusturulma) }),
          ),
        ),
      );
    }
    els.history.replaceChildren(...nodes);
    if (focusedId) els.history.querySelector(`[data-record="${CSS.escape(focusedId)}"]`)?.focus();
  }

  let historySig = '';
  function renderHistoryIfChanged() {
    const ids = [];
    for (const a of activities.values()) if (a.kayitId) ids.push(a.kayitId);
    const sig = `${records.length}|${records[0]?.id}|${ids.sort().join(',')}|${current.recordId}|${current.activityId}`;
    if (sig === historySig) return;
    historySig = sig;
    renderHistory();
  }

  function renderAll() {
    renderStats();
    renderLanes();
    renderFeed();
    renderHistoryIfChanged();
  }

  // ---------- Public ----------

  return {
    applySnapshot,
    applyEvent,
    isReady: () => ready,
    stats: () => stats,
    get: (id) => activities.get(id) ?? null,
    /** The newest activity that produced or returned this record. */
    latestFor(recordId) {
      for (const id of order) {
        const a = activities.get(id);
        if (a?.kayitId === recordId) return a;
      }
      return null;
    },
    recordMeta: (id) => records.find((r) => r.id === id) ?? null,
    setRecords(list) {
      records = list;
      renderHistoryIfChanged();
    },
    setFilter(next) {
      if (!FILTERS[next] || next === filter) return;
      filter = next;
      for (const b of els.filters.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.filter === next));
      renderFeed();
    },
    setCurrent(next) {
      if (next.activityId === current.activityId && next.recordId === current.recordId) return;
      current = next;
      renderAll();
    },
  };
}
