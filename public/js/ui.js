// Shared interface pieces: page title, toasts, dialogs, form fields and their errors, menus,
// animated numbers, empty and loading states, the pager, and the page-wide file drop target.

import { $, el, icon, ICONS, reducedMotion } from './dom.js';
import { fmtClock, fmtCount, fmtElapsed, initials } from './format.js';

let uidCounter = 0;
export const uid = (prefix = 'u') => `${prefix}-${++uidCounter}`;

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// ---------- Document title: "(2) Masraflarım · Masraf" while two invoices are being read ----------

let pageTitle = '';
let titleCount = 0;

function renderTitle() {
  document.title = `${titleCount > 0 ? `(${fmtCount(titleCount)}) ` : ''}${pageTitle ? `${pageTitle} · ` : ''}Masraf`;
}

export function setPageTitle(text) {
  pageTitle = text ?? '';
  renderTitle();
}

export function setTitleCount(n) {
  titleCount = n;
  renderTitle();
}

// ---------- Toasts ----------

export function toast(text, kind) {
  const box = $('toasts');
  if (!box || !text) return;
  const glyph = kind === 'err' ? ICONS.warn : kind === 'ok' ? ICONS.check : ICONS.info;
  const node = el('div', { className: `toast${kind ? ` ${kind}` : ''}` }, icon(glyph), el('span', { text }));
  box.append(node);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(
    () => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 260);
    },
    kind === 'err' ? 6500 : 3800,
  );
}

/** Shows a failed call's message, unless the call was cancelled or ended in the login screen. */
export function showError(r) {
  if (!r || r.ok || r.aborted || r.unauthorized) return;
  toast(r.error?.mesaj ?? 'Beklenmeyen bir hata oluştu.', 'err');
}

/** Running clocks: one timer updates every [data-since] on the page. */
export function tickClocks() {
  const now = Date.now();
  for (const node of document.querySelectorAll('[data-since]')) {
    const since = Date.parse(node.dataset.since);
    if (Number.isNaN(since)) continue;
    node.textContent = node.dataset.fmt === 'clock' ? fmtClock(now - since) : fmtElapsed(now - since);
  }
}

// ---------- Buttons and page heads ----------

/** btn('Kaydet', { icon: ICONS.check, kind: 'primary', onClick }) or with href for a link. */
export function btn(label, { icon: d, kind, href, onClick, type = 'button', size, title, iconOnly = false, disabled, attrs = {} } = {}) {
  const className = ['btn', kind && `btn-${kind}`, size && `btn-${size}`, iconOnly && 'btn-icon'].filter(Boolean).join(' ');
  const children = [d ? icon(d) : null, el('span', { className: iconOnly ? 'visually-hidden' : null, text: label })];
  if (href) return el('a', { className, href, title: title ?? (iconOnly ? label : null), ...attrs }, ...children);
  return el('button', { className, type, title: title ?? (iconOnly ? label : null), disabled, onClick, ...attrs }, ...children);
}

export function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

/** The heading block every view starts with; the h1 takes focus after navigation. */
export function pageHead({ title, sub, eyebrow, actions = [], back } = {}) {
  return el(
    'header',
    { className: 'page-head' },
    el(
      'div',
      { className: 'page-titles' },
      back ? el('a', { className: 'back-link', href: back.href }, icon(ICONS.arrowLeft), el('span', { text: back.label })) : null,
      eyebrow ? el('p', { className: 'eyebrow', text: eyebrow }) : null,
      el('h1', { tabindex: '-1', text: title }),
      sub ? (typeof sub === 'string' ? el('p', { className: 'page-sub', text: sub }) : sub) : null,
    ),
    actions.filter(Boolean).length > 0 ? el('div', { className: 'page-actions' }, ...actions.filter(Boolean)) : null,
  );
}

export function avatar(name, className = '') {
  return el('span', { className: `avatar ${className}`.trim(), 'aria-hidden': 'true', text: initials(name) });
}

// ---------- States ----------

export function emptyState({ icon: d = ICONS.inbox, title, text, action } = {}) {
  return el(
    'div',
    { className: 'empty' },
    el('span', { className: 'empty-icon', 'aria-hidden': 'true' }, icon(d)),
    title ? el('p', { className: 'empty-title', text: title }) : null,
    text ? el('p', { className: 'empty-text', text }) : null,
    action ?? null,
  );
}

export function skeletonList(rows = 5) {
  const list = el('div', { className: 'skeleton-list', role: 'status', 'aria-label': 'Yükleniyor' });
  for (let i = 0; i < rows; i++) list.append(el('div', { className: 'sk-row' }, el('span'), el('span'), el('span')));
  return list;
}

/** A whole view that could not load: the server's message and a retry button. */
export function loadFailed(r, retry) {
  const offline = r?.error?.kod === 'baglanti';
  return el(
    'div',
    { className: 'notice' },
    el('h2', { text: r?.error?.durum === 404 ? 'Bulunamadı' : offline ? 'Bağlantı yok' : 'Yüklenemedi' }),
    el('p', { text: r?.error?.mesaj ?? 'Beklenmeyen bir hata oluştu.' }),
    retry ? el('div', { className: 'buttons' }, btn('Tekrar dene', { icon: ICONS.refresh, onClick: retry })) : null,
  );
}

export function alertBox(kind, title, items = []) {
  const list = items.filter(Boolean);
  return el(
    'div',
    { className: `alert ${kind}`, role: kind === 'err' ? 'alert' : null },
    icon(kind === 'ok' ? ICONS.checkCircle : kind === 'info' ? ICONS.info : ICONS.warn),
    el(
      'div',
      { className: 'alert-body' },
      title ? el('p', { className: 'alert-title', text: title }) : null,
      list.length === 1 && title ? el('p', { text: list[0] }) : null,
      list.length === 1 && !title ? el('p', { text: list[0] }) : null,
      list.length > 1 ? el('ul', {}, ...list.map((t) => el('li', { text: t }))) : null,
    ),
  );
}

// ---------- Animated numbers ----------

/**
 * A number that counts up once when shown. Screen readers get the final value only.
 * format(value) turns the running number into text; counts should round inside it.
 */
export function animatedValue(value, format, { duration = 700 } = {}) {
  const shown = el('span', { 'aria-hidden': 'true', text: format(value) });
  const wrap = el('span', { className: 'num-anim' }, shown, el('span', { className: 'visually-hidden', text: format(value) }));
  if (!reducedMotion.matches && Number.isFinite(value) && value !== 0) {
    shown.textContent = format(0);
    requestAnimationFrame((start) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 3;
        shown.textContent = format(value * eased);
        if (t < 1 && shown.isConnected) requestAnimationFrame(step);
        else shown.textContent = format(value);
      };
      requestAnimationFrame(step);
    });
  }
  return wrap;
}

// ---------- Form fields ----------

/** A labelled control with a hint and an error slot wired through aria-describedby. */
export function field({ label, input, hint, optional = false, className = '' }) {
  if (!input.id) input.id = uid('f');
  const hintId = hint ? `${input.id}-hint` : null;
  const errId = `${input.id}-err`;
  input.setAttribute('aria-describedby', [hintId, errId].filter(Boolean).join(' '));
  return el(
    'div',
    { className: `field ${className}`.trim() },
    el('label', { for: input.id }, label, optional ? el('span', { className: 'optional', text: ' (isteğe bağlı)' }) : null),
    input,
    hint ? (typeof hint === 'string' ? el('p', { className: 'hint', id: hintId, text: hint }) : el('div', { className: 'hint', id: hintId }, hint)) : null,
    el('p', { className: 'field-error', id: errId, hidden: true }),
  );
}

/** A group of radios or checkboxes with a legend and its own error slot. */
export function fieldset({ legend, content, hint, className = '', id = uid('fs') }) {
  const errId = `${id}-err`;
  const hintId = hint ? `${id}-hint` : null;
  return el(
    'fieldset',
    { className: `field ${className}`.trim(), id, 'aria-describedby': [hintId, errId].filter(Boolean).join(' ') },
    el('legend', { text: legend }),
    hint ? el('p', { className: 'hint', id: hintId, text: hint }) : null,
    content,
    el('p', { className: 'field-error', id: errId, hidden: true }),
  );
}

export const input = (props = {}) => el('input', { className: 'input', type: 'text', ...props });
export const textarea = (props = {}) => el('textarea', { className: 'input', rows: 3, ...props });

export function select(options, props = {}) {
  const node = el('select', { className: 'input', ...props });
  for (const o of options) node.append(el('option', { value: o.value, text: o.label, disabled: o.disabled }));
  if (props.value !== undefined) node.value = String(props.value);
  return node;
}

/** target: the control (or fieldset) the message belongs to; an empty message clears it. */
export function setFieldError(target, message) {
  if (!target) return;
  const holder = target.matches('fieldset') ? target : target.closest('.field');
  const err = holder?.querySelector(':scope > .field-error');
  if (message) {
    target.setAttribute('aria-invalid', 'true');
    if (err) {
      err.replaceChildren(icon(ICONS.alert), el('span', { text: message }));
      err.hidden = false;
    }
  } else {
    target.removeAttribute('aria-invalid');
    if (err) {
      err.replaceChildren();
      err.hidden = true;
    }
  }
}

export function clearFieldErrors(root) {
  for (const node of root.querySelectorAll('[aria-invalid="true"]')) setFieldError(node, null);
}

/**
 * Puts the server's `alanlar` messages under their controls. fields maps an API field name to its
 * control. Returns the messages that had no control, for a summary box. Focuses the first one.
 */
export function applyFieldErrors(alanlar, fields) {
  const leftovers = [];
  let first = null;
  for (const [name, message] of Object.entries(alanlar ?? {})) {
    const target = fields[name];
    if (target) {
      setFieldError(target, String(message));
      first ??= target;
    } else {
      leftovers.push(String(message));
    }
  }
  focusControl(first);
  return leftovers;
}

export function focusControl(target) {
  if (!target) return;
  const focusable = target.matches('fieldset') ? target.querySelector('input:checked, input, select, button') : target;
  focusable?.focus();
}

// ---------- Dialogs (native <dialog>: modal, Esc closes, the page behind is inert) ----------

const openDialogs = new Set();

/**
 * openDialog({ title, description, body: [nodes], submitLabel, submitKind, cancelLabel, onSubmit, size })
 * onSubmit(ctl) may be async; returning false keeps the dialog open, anything else closes it with
 * that value (undefined → true). Without onSubmit the submit button simply closes with true.
 * Returns ctl: { dialog, form, close(value), setError(message, items), setBusy(on), done: Promise }.
 */
export function openDialog({
  title,
  description,
  body = [],
  submitLabel = null,
  submitKind = 'primary',
  submitIcon = null,
  cancelLabel = 'Vazgeç',
  onSubmit = null,
  size = '',
  focus = null, // 'submit' | 'cancel'; otherwise the first field, then the submit button
}) {
  const opener = document.activeElement;
  const titleId = uid('dlg-t');
  const descId = description ? uid('dlg-d') : null;
  const errorBox = el('div', { className: 'dlg-error', hidden: true });
  const submitBtn = submitLabel
    ? el('button', { className: `btn btn-${submitKind}`, type: 'submit' }, submitIcon ? icon(submitIcon) : null, el('span', { text: submitLabel }))
    : null;
  const cancelBtn = el('button', { className: 'btn', type: 'button', text: submitLabel ? cancelLabel : 'Kapat' });
  const closeX = el('button', { className: 'icon-btn dlg-x', type: 'button', 'aria-label': 'Kapat' }, icon(ICONS.close));

  const form = el(
    'form',
    { className: 'dlg-form', novalidate: true },
    el(
      'header',
      { className: 'dlg-head' },
      el('div', {}, el('h2', { id: titleId, text: title }), description ? el('p', { className: 'dlg-desc', id: descId, text: description }) : null),
      closeX,
    ),
    el('div', { className: 'dlg-body' }, errorBox, ...body.flat().filter(Boolean)),
    el('footer', { className: 'dlg-foot' }, cancelBtn, submitBtn),
  );
  const dialog = el('dialog', { className: `dlg${size ? ` dlg-${size}` : ''}`, 'aria-labelledby': titleId, 'aria-describedby': descId }, form);
  document.body.append(dialog);

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  let closed = false;
  let busy = false;

  function close(result = null) {
    if (closed) return;
    closed = true;
    openDialogs.delete(ctl);
    const finish = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      resolveDone(result);
    };
    if (reducedMotion.matches) finish();
    else {
      dialog.classList.add('closing');
      setTimeout(finish, 150);
    }
  }

  function setError(message, items = []) {
    if (!message && items.length === 0) {
      errorBox.hidden = true;
      errorBox.replaceChildren();
      return;
    }
    errorBox.replaceChildren(alertBox('err', items.length > 0 ? message : null, items.length > 0 ? items : [message]));
    errorBox.hidden = false;
  }

  function setBusyState(on) {
    busy = on;
    setBusy(submitBtn, on);
    cancelBtn.disabled = on;
    closeX.disabled = on;
  }

  cancelBtn.addEventListener('click', () => close(null));
  closeX.addEventListener('click', () => close(null));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!busy) close(null);
  });
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog && !busy) close(null);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!onSubmit) {
      close(true);
      return;
    }
    setError(null);
    setBusyState(true);
    let result = false;
    try {
      result = await onSubmit(ctl);
    } catch (err) {
      console.error(err);
      setError('Beklenmeyen bir hata oluştu.');
      result = false;
    }
    if (closed) return;
    setBusyState(false);
    if (result !== false) close(result === undefined ? true : result);
  });

  const ctl = { dialog, form, close, setError, setBusy: setBusyState, done, submitButton: submitBtn };
  openDialogs.add(ctl);
  dialog.showModal();
  const firstInput = form.querySelector('.dlg-body [autofocus], .dlg-body input:not([type="hidden"]):not([disabled]), .dlg-body select, .dlg-body textarea');
  let target = firstInput ?? submitBtn ?? cancelBtn;
  if (focus === 'cancel') target = cancelBtn;
  else if (focus === 'submit' && submitBtn) target = submitBtn;
  target.focus();
  return ctl;
}

export function closeAllDialogs() {
  for (const ctl of [...openDialogs]) ctl.close(null);
}

/** Resolves true when confirmed. kind 'danger' puts the focus on "Vazgeç". */
export function confirmDialog({ title, message, confirmLabel = 'Onayla', kind = 'primary', confirmIcon = null, details = [] }) {
  const ctl = openDialog({
    title,
    body: [message ? el('p', { className: 'dlg-text', text: message }) : null, ...details],
    submitLabel: confirmLabel,
    submitKind: kind,
    submitIcon: confirmIcon,
    focus: kind === 'danger' ? 'cancel' : 'submit',
  });
  return ctl.done.then((r) => r === true);
}

/** Runs an API call from inside a confirmation; the server's message stays in the dialog. */
export function actionDialog({ title, message, confirmLabel, kind = 'primary', confirmIcon = null, details = [], run }) {
  const ctl = openDialog({
    title,
    body: [message ? el('p', { className: 'dlg-text', text: message }) : null, ...details],
    submitLabel: confirmLabel,
    submitKind: kind,
    submitIcon: confirmIcon,
    focus: kind === 'danger' ? 'cancel' : 'submit',
    onSubmit: async (c) => {
      const r = await run();
      if (r.ok) return r;
      if (r.unauthorized || r.aborted) return null;
      c.setError(r.error.mesaj, r.error.sorunlar ?? []);
      return false;
    },
  });
  return ctl.done;
}

/** A message with an OK button and optional links (e.g. where to fix the problem). */
export function messageDialog({ title, message, links = [] }) {
  const ctl = openDialog({
    title,
    body: [
      el('p', { className: 'dlg-text', text: message }),
      links.length > 0
        ? el('ul', { className: 'dlg-links' }, ...links.map((l) => el('li', {}, el('a', { href: l.href, onClick: () => ctl.close(null) }, el('span', { text: l.label }), icon(ICONS.chevronRight)))))
        : null,
    ],
  });
  return ctl.done;
}

// ---------- Menu button (user menu, row menus) ----------

/** Wires a button to a [role=menu] element: arrows, Home/End, Esc and outside clicks. */
export function menuButton(button, menu) {
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')].filter((n) => !n.hidden && !n.disabled);
  const outside = (e) => {
    if (!menu.contains(e.target) && !button.contains(e.target)) close(false);
  };
  function open(focusLast = false) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const list = items();
    (focusLast ? list[list.length - 1] : list[0])?.focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function close(returnFocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (returnFocus) button.focus();
  }
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open(e.key === 'ArrowUp');
    }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    } else if (e.key === 'Tab') {
      close(false);
      return;
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('[role^="menuitem"]')) close(false);
  });
  return { open, close };
}

// ---------- Pager ----------

/** "1–20 / 134" with previous/next and a few page numbers. */
export function pager({ sayfa, adet, toplam, onPage }) {
  const pages = Math.max(1, Math.ceil(toplam / adet));
  if (toplam <= adet && sayfa <= 1) return null;
  const from = toplam === 0 ? 0 : (sayfa - 1) * adet + 1;
  const to = Math.min(toplam, sayfa * adet);
  const pageBtn = (n) =>
    el('button', {
      className: 'pg',
      type: 'button',
      text: fmtCount(n),
      'aria-label': `Sayfa ${n}`,
      'aria-current': n === sayfa ? 'page' : null,
      onClick: () => n !== sayfa && onPage(n),
    });
  const numbers = [];
  const start = Math.max(1, Math.min(sayfa - 2, pages - 4));
  const end = Math.min(pages, start + 4);
  if (start > 1) numbers.push(pageBtn(1), start > 2 ? el('span', { className: 'pg-gap', text: '…' }) : null);
  for (let n = start; n <= end; n++) numbers.push(pageBtn(n));
  if (end < pages) numbers.push(end < pages - 1 ? el('span', { className: 'pg-gap', text: '…' }) : null, pageBtn(pages));
  return el(
    'nav',
    { className: 'pager', 'aria-label': 'Sayfalar' },
    el('p', { className: 'pg-info', text: `${fmtCount(from)}–${fmtCount(to)} / ${fmtCount(toplam)}` }),
    el(
      'div',
      { className: 'pg-buttons' },
      el('button', { className: 'pg', type: 'button', 'aria-label': 'Önceki sayfa', disabled: sayfa <= 1, onClick: () => onPage(sayfa - 1) }, icon(ICONS.chevronLeft)),
      ...numbers.filter(Boolean),
      el('button', { className: 'pg', type: 'button', 'aria-label': 'Sonraki sayfa', disabled: sayfa >= pages, onClick: () => onPage(sayfa + 1) }, icon(ICONS.chevronRight)),
    ),
  );
}

// ---------- Page-wide file target: drag and drop, and pasting a screenshot ----------

let fileTarget = null; // { label, onFiles(files) } of the view that takes files right now
let dragDepth = 0;

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function setDragging(on) {
  const drop = $('drop');
  if (drop) {
    drop.hidden = !on;
    const label = $('drop-text');
    if (label && fileTarget) label.textContent = fileTarget.label;
  }
  document.body.classList.toggle('dragging', on);
}

/** The active view registers where dropped or pasted files go; null when it goes away. */
export function setFileTarget(target) {
  fileTarget = target;
  if (!target) {
    dragDepth = 0;
    setDragging(false);
  }
}

export function initFileTarget() {
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!fileTarget) return;
    dragDepth += 1;
    setDragging(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never let the browser open a dropped file in place of the panel
    if (!fileTarget && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e) || !fileTarget) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDragging(false);
    if (fileTarget) fileTarget.onFiles([...e.dataTransfer.files]);
  });
  window.addEventListener('paste', (e) => {
    if (!fileTarget) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length > 0) {
      e.preventDefault();
      fileTarget.onFiles(files);
    }
  });
}
