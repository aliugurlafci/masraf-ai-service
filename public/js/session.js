// The signed-in user, the pending-approval count for the badge, and the company currency.
// Nothing here is persisted: the session itself lives in the server's HttpOnly cookie.

import * as api from './api.js';

let user = null;
let pending = 0;
let baseCurrency = null;
let currencyLoad = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn({ user, pending });
}

export const currentUser = () => user;
export const pendingCount = () => pending;
export const hasRole = (...roles) => Boolean(user && roles.includes(user.rol));
export const isManager = () => hasRole('yonetici');
export const isFinance = () => hasRole('muhasebe', 'yonetici');

/** fn({ user, pending }) after every change; returns an unsubscribe function. */
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSession(nextUser, bekleyen) {
  user = nextUser;
  if (typeof bekleyen === 'number') pending = bekleyen;
  emit();
}

export function setPending(n) {
  if (typeof n !== 'number' || n === pending) return;
  pending = n;
  emit();
}

export function clearSession() {
  user = null;
  pending = 0;
  baseCurrency = null;
  currencyLoad = null;
  emit();
}

/** GET /api/ben: the light call behind the badge. */
export async function refreshMe(opts) {
  const r = await api.me(opts);
  if (r.ok && r.body?.kullanici) {
    if (typeof r.body.paraBirimi === 'string') setBaseCurrency(r.body.paraBirimi);
    setSession(r.body.kullanici, typeof r.body.bekleyenOnay === 'number' ? r.body.bekleyenOnay : pending);
  }
  return r;
}

export function setBaseCurrency(code) {
  if (typeof code === 'string' && /^[A-Z]{3}$/.test(code)) baseCurrency = code;
}

/** The currency approval limits are in (PARA_BIRIMI). Known after the first summary or preview. */
export const knownBaseCurrency = () => baseCurrency;

/**
 * The contract has no light call for PARA_BIRIMI; the dashboard summary carries it. Loaded once per
 * session, falling back to TRY.
 */
export function loadBaseCurrency() {
  if (baseCurrency) return Promise.resolve(baseCurrency);
  if (!currencyLoad) {
    currencyLoad = api.summary().then((r) => {
      if (r.ok) setBaseCurrency(r.body?.paraBirimi);
      return baseCurrency ?? 'TRY';
    });
  }
  return currencyLoad;
}

// ---------- Badge refresh: every minute while visible, and when the tab comes back ----------

const POLL_MS = 60_000;
const MIN_GAP_MS = 10_000;
let timer = null;
let last = 0;

function refreshSoon() {
  if (!user || document.hidden || Date.now() - last < MIN_GAP_MS) return;
  last = Date.now();
  refreshMe();
}

function onVisible() {
  if (!document.hidden) refreshSoon();
}

export function startPolling() {
  stopPolling();
  last = Date.now();
  timer = setInterval(refreshSoon, POLL_MS);
  window.addEventListener('focus', refreshSoon);
  document.addEventListener('visibilitychange', onVisible);
}

export function stopPolling() {
  clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', refreshSoon);
  document.removeEventListener('visibilitychange', onVisible);
}
