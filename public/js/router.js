// Hash routing: #/masraflar/1001, #/masraflar?durum=onayda&sayfa=2.
//
// A route definition: { name, path: '/masraflar/:id', params: { id: /^\d+$/ }, roles?, title, view }.
// A view is { mount(container, { route, signal }) → { update?(route) → boolean, canLeave?(route), unmount?() } }.
// When the next address belongs to the same view, update(route) is tried first; returning false
// remounts the view. The signal aborts when the view goes away.
//
// canLeave(nextRoute) lets a view with unsaved changes keep its address: it returns true to let the
// change through, or false / a Promise<boolean> (a "discard changes?" dialog). While it asks, the
// address goes back to the view's own; once confirmed, the router moves on to the asked address.
// Signing out and reload() do not ask.

let config = null;
let active = null;
let listening = false;
let leaveAsking = false;
let leaveApproved = null; // the address a view already agreed to leave for

function splitHash(hash) {
  const raw = hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  return { path, query };
}

function segments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function matchPath(def, path) {
  const want = def.path.split('/').filter(Boolean);
  const got = segments(path);
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      const name = want[i].slice(1);
      const test = def.params?.[name];
      if (test && !test.test(got[i])) return null;
      params[name] = got[i];
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

/** '#/masraflar?durum=onayda' from a path and a query object (empty values are dropped). */
export function href(path, query) {
  const p = new URLSearchParams();
  const entries = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query ?? {});
  for (const [k, v] of entries) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return `#${path}${s ? `?${s}` : ''}`;
}

export function navigate(path, { query, replace = false } = {}) {
  const url = href(path, query);
  if (replace) {
    history.replaceState(history.state, '', url);
    resolve();
  } else if (location.hash === url) {
    resolve();
  } else {
    location.hash = url;
  }
}

export const currentRoute = () => active?.route ?? null;

const currentHash = () => location.hash || '#/';

function unmountActive() {
  if (!active) return;
  active.controller.abort();
  try {
    active.instance?.unmount?.();
  } catch (err) {
    console.error(err);
  }
  active = null;
}

function mount(route, initial) {
  unmountActive();
  // Dialogs belong to the view that opened them (e.g. Back pressed while one is open); close them before
  // the next view mounts, so a view that opens a dialog while mounting keeps it.
  config.onLeave?.();
  const controller = new AbortController();
  config.outlet.replaceChildren();
  let instance = {};
  try {
    instance = route.def.view.mount(config.outlet, { route, signal: controller.signal }) ?? {};
  } catch (err) {
    console.error(err);
    config.onError?.(err);
  }
  active = { route, instance, controller, hash: currentHash() };
  config.onRoute(route, { updated: false, initial });
}

/** True when the active view lets the address change now; otherwise it asks and the router waits. */
function mayLeave(route) {
  const target = currentHash();
  const approved = leaveApproved === target;
  leaveApproved = null;
  if (approved || !active || target === active.hash || typeof active.instance?.canLeave !== 'function') return true;
  const stay = () => history.replaceState(history.state, '', active.hash);
  if (leaveAsking) {
    stay(); // the view is already asking; this change is dropped
    return false;
  }
  let verdict = true;
  try {
    verdict = active.instance.canLeave(route);
  } catch (err) {
    console.error(err);
  }
  if (verdict === true) return true;
  stay();
  leaveAsking = true;
  Promise.resolve(verdict)
    .catch(() => false)
    .then((ok) => {
      leaveAsking = false;
      if (ok !== true || !config || currentHash() === target) return;
      leaveApproved = target;
      location.hash = target;
    });
  return false;
}

function resolve(initial = false) {
  if (!config) return;
  const raw = location.hash.replace(/^#/, '');
  if (raw !== '' && !raw.startsWith('/')) {
    // Addresses from before the router (#<record id>, #a-<activity id>) or a stray fragment.
    history.replaceState(history.state, '', config.legacy?.(raw) ?? '#/');
  }
  const { path, query } = splitHash(location.hash);
  let def = null;
  let params = {};
  for (const r of config.routes) {
    const p = matchPath(r, path || '/');
    if (p) {
      def = r;
      params = p;
      break;
    }
  }
  if (!def) def = config.notFound;
  else if (def.roles && !config.canAccess(def.roles)) def = config.forbidden;

  const route = { def, name: def.name, params, query, path: path || '/' };
  if (!mayLeave(route)) return;
  // The same view under another address (e.g. #/okuma and #/okuma/<id>) may take the change itself.
  if (active && active.route.def.view === def.view && typeof active.instance?.update === 'function') {
    let handled = false;
    try {
      handled = active.instance.update(route) !== false;
    } catch (err) {
      console.error(err);
    }
    if (handled) {
      active.route = route;
      active.hash = currentHash();
      config.onRoute(route, { updated: true, initial: false });
      return;
    }
  }
  mount(route, initial);
}

/**
 * cfg: { outlet, routes, notFound, forbidden, canAccess(roles), onRoute(route, { updated, initial }),
 *        legacy?(rawHash) → new hash, onError?(err) }
 */
export function startRouter(cfg) {
  config = cfg;
  if (!listening) {
    window.addEventListener('hashchange', () => resolve());
    listening = true;
  }
  resolve(true);
}

/** Leaves the current view (sign-out); the address stays for the next sign-in. */
export function stopRouter() {
  unmountActive();
  config = null;
}

/** Mounts the current address again, e.g. after the user's role changed. */
export function reload() {
  if (!config) return;
  unmountActive();
  resolve();
}
