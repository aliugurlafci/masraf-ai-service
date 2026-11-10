// Masraf panel: sign-in, the application shell (role-based menu, user menu, approvals badge) and
// the hash routes. Every screen lives in js/views/; the invoice reader is views/okuma.js.

import * as api from './api.js';
import { $, el, icon, ICONS, replay } from './dom.js';
import { fmtCount, initials } from './format.js';
import { roleLabel } from './labels.js';
import { currentRoute, reload, startRouter, stopRouter } from './router.js';
import * as session from './session.js';
import { closeAllDialogs, initFileTarget, menuButton, setPageTitle, tickClocks, toast } from './ui.js';
import { approvalsView } from './views/approvals.js';
import { auditView } from './views/audit.js';
import { categoriesView } from './views/categories.js';
import { dashboardView } from './views/dashboard.js';
import { costCentresView, optionListsView, organizationsView } from './views/definitions.js';
import { emailView } from './views/email.js';
import { expenseDetailView } from './views/expense-detail.js';
import { expenseFormView } from './views/expense-form.js';
import { allExpensesView, myExpensesView } from './views/expenses.js';
import { fieldsAdminView } from './views/fields-admin.js';
import { flowView } from './views/flow.js';
import { renderLogin, renderPasswordChange } from './views/login.js';
import { forbiddenView, notFoundView } from './views/misc.js';
import { notificationsView } from './views/notifications.js';
import { okumaView, onReadingCount, resetReading, startLive } from './views/okuma.js';
import { profileView } from './views/profile.js';
import { usersView } from './views/users.js';

const FINANCE = ['muhasebe', 'yonetici'];
const MANAGER = ['yonetici'];
const ID = /^\d+$/;
const RECORD_OR_ACTIVITY = /^(\d{8}-\d{6}-[a-f0-9]{8}|a-[a-f0-9]{12})$/;

// `nav` is the menu entry that lights up for the route.
const ROUTES = [
  { name: 'gosterge', path: '/', title: 'Gösterge', nav: '/', view: dashboardView },
  { name: 'yeni-masraf', path: '/masraflar/yeni', title: 'Yeni masraf', nav: '/masraflar/yeni', view: expenseFormView },
  { name: 'masraf-duzenle', path: '/masraflar/:id/duzenle', params: { id: ID }, title: 'Masrafı düzenle', nav: '/masraflar', view: expenseFormView },
  { name: 'masraf', path: '/masraflar/:id', params: { id: ID }, title: 'Masraf', nav: '/masraflar', view: expenseDetailView },
  { name: 'masraflar', path: '/masraflar', title: 'Masraflarım', nav: '/masraflar', view: myExpensesView },
  { name: 'tum-masraflar', path: '/tum-masraflar', title: 'Tüm masraflar', nav: '/tum-masraflar', roles: FINANCE, view: allExpensesView },
  { name: 'onaylar', path: '/onaylar', title: 'Onaylarım', nav: '/onaylar', view: approvalsView },
  { name: 'okuma', path: '/okuma', title: 'Fatura okuma', nav: '/okuma', view: okumaView },
  { name: 'okuma-kayit', path: '/okuma/:target', params: { target: RECORD_OR_ACTIVITY }, title: 'Fatura okuma', nav: '/okuma', view: okumaView },
  { name: 'kullanicilar', path: '/kullanicilar', title: 'Kullanıcılar', nav: '/kullanicilar', roles: MANAGER, view: usersView },
  { name: 'onay-akisi', path: '/onay-akisi', title: 'Onay akışları', nav: '/onay-akisi', roles: MANAGER, view: flowView },
  { name: 'organizasyonlar', path: '/organizasyonlar', title: 'Organizasyonlar', nav: '/organizasyonlar', roles: MANAGER, view: organizationsView },
  { name: 'masraf-merkezleri', path: '/masraf-merkezleri', title: 'Masraf merkezleri', nav: '/masraf-merkezleri', roles: MANAGER, view: costCentresView },
  { name: 'kategoriler', path: '/kategoriler', title: 'Kategoriler', nav: '/kategoriler', roles: MANAGER, view: categoriesView },
  { name: 'fis-listeleri', path: '/fis-listeleri', title: 'Fiş listeleri', nav: '/fis-listeleri', roles: MANAGER, view: optionListsView },
  { name: 'alanlar', path: '/alanlar', title: 'Alan yönetimi', nav: '/alanlar', roles: MANAGER, view: fieldsAdminView },
  { name: 'denetim', path: '/denetim', title: 'Denetim kaydı', nav: '/denetim', roles: MANAGER, view: auditView },
  { name: 'bildirimler', path: '/bildirimler', title: 'Bildirimler', nav: null, view: notificationsView },
  { name: 'eposta', path: '/eposta', title: 'E-posta', nav: '/eposta', roles: MANAGER, view: emailView },
  { name: 'profil', path: '/profil', title: 'Profil', nav: null, view: profileView },
];
const NOT_FOUND = { name: 'bulunamadi', title: 'Sayfa bulunamadı', nav: null, view: notFoundView };
const FORBIDDEN = { name: 'yetki-yok', title: 'Yetki yok', nav: null, view: forbiddenView };

const NAV = [
  {
    items: [
      { path: '/', label: 'Gösterge', icon: ICONS.home },
      { path: '/masraflar', label: 'Masraflarım', icon: ICONS.receipt },
      { path: '/masraflar/yeni', label: 'Yeni masraf', icon: ICONS.plus },
      { path: '/onaylar', label: 'Onaylarım', icon: ICONS.inbox, badge: true },
      { path: '/okuma', label: 'Fatura okuma', icon: ICONS.scan },
    ],
  },
  { title: 'Muhasebe', roles: FINANCE, items: [{ path: '/tum-masraflar', label: 'Tüm masraflar', icon: ICONS.layers }] },
  {
    title: 'Yönetim',
    roles: MANAGER,
    items: [
      { path: '/kullanicilar', label: 'Kullanıcılar', icon: ICONS.users },
      { path: '/onay-akisi', label: 'Onay akışları', icon: ICONS.flow },
      { path: '/eposta', label: 'E-posta', icon: ICONS.mail },
      { path: '/denetim', label: 'Denetim kaydı', icon: ICONS.log },
    ],
  },
  {
    title: 'Tanımlar',
    roles: MANAGER,
    items: [
      { path: '/organizasyonlar', label: 'Organizasyonlar', icon: ICONS.building },
      { path: '/masraf-merkezleri', label: 'Masraf merkezleri', icon: ICONS.target },
      { path: '/kategoriler', label: 'Kategoriler', icon: ICONS.tag },
      { path: '/fis-listeleri', label: 'Fiş listeleri', icon: ICONS.list },
      { path: '/alanlar', label: 'Alan yönetimi', icon: ICONS.sliders },
    ],
  },
];

const boot = $('boot');
const auth = $('auth');
const shell = $('shell');
const outlet = $('view');
const okumaSection = $('okuma');
const nav = $('nav');
const navToggle = $('nav-toggle');
const navScrim = $('nav-scrim');
const userBtn = $('user-btn');
const userMenu = $('user-menu');
const readingPill = $('reading-pill');
const narrow = matchMedia('(max-width: 1024px)'); // the sidebar becomes a drawer (css: same breakpoint)

let phase = 'boot'; // boot | login | password | app
let navRole = null;
let readingCount = 0;

// ---------- Theme (system, light, dark) ----------

const THEME_KEY = 'masraf-tema';

function storedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  for (const item of userMenu.querySelectorAll('[data-theme-choice]')) item.setAttribute('aria-checked', String(item.dataset.themeChoice === theme));
}

// ---------- Menu ----------

function renderNav() {
  const user = session.currentUser();
  navRole = user?.rol ?? null;
  const groups = [];
  for (const group of NAV) {
    if (group.roles && !session.hasRole(...group.roles)) continue;
    const list = el('ul', { className: 'nav-list' });
    for (const item of group.items) {
      list.append(
        el(
          'li',
          {},
          el(
            'a',
            { className: 'nav-item', href: `#${item.path}`, 'data-nav': item.path },
            icon(item.icon),
            el('span', { className: 'nav-label', text: item.label }),
            item.badge ? el('span', { className: 'badge', id: 'approvals-badge', 'aria-hidden': 'true', hidden: true }) : null,
            item.badge ? el('span', { className: 'visually-hidden', id: 'approvals-badge-sr' }) : null,
          ),
        ),
      );
    }
    if (group.title) {
      const id = `nav-${group.title.toLowerCase()}`;
      list.setAttribute('aria-labelledby', id);
      groups.push(el('p', { className: 'nav-group', id, text: group.title }));
    }
    groups.push(list);
  }
  nav.replaceChildren(...groups);
  updateBadge(session.pendingCount(), false);
  highlightNav(currentRoute()?.def.nav ?? null);
}

// The expense detail asks for the menu entry its back link points to (Masraflarım, Tüm masraflar, Onaylarım).
window.addEventListener('nav-highlight', (e) => highlightNav(e.detail));

function highlightNav(path) {
  for (const a of nav.querySelectorAll('.nav-item')) {
    if (a.dataset.nav === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

let lastBadge = 0;
function updateBadge(n, animate = true) {
  const badge = $('approvals-badge');
  const sr = $('approvals-badge-sr');
  if (!badge) return;
  badge.hidden = n <= 0;
  badge.textContent = n > 99 ? '99+' : fmtCount(n);
  sr.textContent = n > 0 ? `, ${fmtCount(n)} onay bekliyor` : '';
  if (animate && n > lastBadge) replay(badge, 'bump');
  lastBadge = n;
}

function updateUserButton(user) {
  $('user-avatar').textContent = initials(user.adSoyad);
  $('user-name').textContent = user.adSoyad;
  $('user-role').textContent = roleLabel(user.rol);
  userBtn.setAttribute('aria-label', `${user.adSoyad}, ${roleLabel(user.rol)}: kullanıcı menüsü`);
}

function renderUserMenu() {
  const theme = storedTheme();
  const themeItem = (value, label, d) =>
    el('button', { type: 'button', role: 'menuitemradio', tabindex: '-1', 'aria-checked': String(theme === value), 'data-theme-choice': value, onClick: () => applyTheme(value) }, icon(d), el('span', { text: label }));
  userMenu.replaceChildren(
    el('a', { role: 'menuitem', tabindex: '-1', href: '#/profil' }, icon(ICONS.user), el('span', { text: 'Profil' })),
    el('a', { role: 'menuitem', tabindex: '-1', href: '#/profil?bolum=sifre' }, icon(ICONS.key), el('span', { text: 'Şifre değiştir' })),
    el('div', { role: 'separator', className: 'menu-sep' }),
    el('div', { role: 'group', 'aria-labelledby': 'theme-label' }, el('p', { className: 'menu-label', id: 'theme-label', text: 'Tema' }), themeItem('system', 'Sistem', ICONS.monitor), themeItem('light', 'Açık', ICONS.sun), themeItem('dark', 'Koyu', ICONS.moon)),
    el('div', { role: 'separator', className: 'menu-sep' }),
    el('button', { type: 'button', role: 'menuitem', tabindex: '-1', className: 'danger', onClick: logout }, icon(ICONS.logout), el('span', { text: 'Çıkış yap' })),
  );
}

// ---------- Narrow screens: the menu is a drawer ----------

function openNav() {
  shell.classList.add('nav-open');
  navScrim.hidden = false;
  navToggle.setAttribute('aria-expanded', 'true');
  (nav.querySelector('[aria-current="page"]') ?? nav.querySelector('.nav-item'))?.focus();
}

function closeNav(returnFocus = false) {
  if (!shell.classList.contains('nav-open')) return;
  shell.classList.remove('nav-open');
  navScrim.hidden = true;
  navToggle.setAttribute('aria-expanded', 'false');
  if (returnFocus) navToggle.focus();
}

navToggle.addEventListener('click', openNav);
$('nav-close').addEventListener('click', () => closeNav(true));
navScrim.addEventListener('click', () => closeNav(true));
nav.addEventListener('click', (e) => {
  if (e.target.closest('.nav-item')) closeNav();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && shell.classList.contains('nav-open')) closeNav(true);
});
narrow.addEventListener('change', () => closeNav());

menuButton(userBtn, userMenu);

$('skip').addEventListener('click', (e) => {
  e.preventDefault();
  const scope = okumaSection.hidden ? outlet : okumaSection;
  (scope.querySelector('h1') ?? $('main')).focus();
});

// ---------- Reads running on the server (pill in the top bar) ----------

function updateReadingPill() {
  const onReader = !okumaSection.hidden;
  readingPill.hidden = readingCount === 0 || onReader || phase !== 'app';
  $('reading-pill-text').textContent = `${fmtCount(readingCount)} fatura okunuyor`;
}

onReadingCount((n) => {
  readingCount = n;
  updateReadingPill();
});

// ---------- Routes ----------

function onRoute(route, { updated, initial }) {
  highlightNav(route.def.nav);
  closeNav();
  $('topbar-new').hidden = route.name === 'yeni-masraf';
  updateReadingPill();
  if (updated) return;
  setPageTitle(route.def.title);
  const scope = okumaSection.hidden ? outlet : okumaSection;
  $('main').scrollTop = 0;
  if (okumaSection.hidden) {
    window.scrollTo(0, 0);
    replay(outlet, 'view-enter');
  }
  if (!initial) scope.querySelector('h1')?.focus({ preventScroll: true });
}

const routerConfig = {
  outlet,
  routes: ROUTES,
  notFound: NOT_FOUND,
  forbidden: FORBIDDEN,
  canAccess: (roles) => session.hasRole(...roles),
  onRoute,
  onLeave: closeAllDialogs,
  // Addresses of the old single-screen reader: #<record id> and #a-<activity id>.
  legacy: (raw) => (RECORD_OR_ACTIVITY.test(raw) ? `#/okuma/${raw}` : '#/'),
  onError: () => toast('Bu sayfa açılırken bir hata oluştu.', 'err'),
};

// ---------- Sign-in flow ----------

function showAuth() {
  boot.hidden = true;
  shell.hidden = true;
  auth.hidden = false;
}

function showLogin(notice = null) {
  phase = 'login';
  showAuth();
  setPageTitle('Giriş');
  renderLogin(auth, { notice, onSuccess: onSignedIn });
}

function showPasswordChange() {
  phase = 'password';
  showAuth();
  setPageTitle('Yeni şifre');
  renderPasswordChange(auth, {
    user: session.currentUser(),
    onDone: () => {
      const user = session.currentUser();
      if (user) session.setSession({ ...user, sifreDegismeli: false });
      toast('Şifreniz değiştirildi.', 'ok');
      enterApp();
    },
    onLogout: logout,
  });
}

function onSignedIn(kullanici) {
  session.setSession(kullanici);
  if (kullanici?.sifreDegismeli) showPasswordChange();
  else enterApp();
  session.refreshMe(); // the badge count comes with /api/ben
}

function enterApp() {
  phase = 'app';
  auth.hidden = true;
  auth.replaceChildren();
  boot.hidden = true;
  shell.hidden = false;
  const user = session.currentUser();
  updateUserButton(user);
  renderUserMenu();
  renderNav();
  updateBell(session.unreadCount(), false);
  startLive();
  session.startPolling();
  startRouter(routerConfig);
}

/** Back to a clean page: no view, no live connection, no cached data of the previous user. */
function leaveApp() {
  stopRouter();
  closeAllDialogs();
  closeNav();
  userMenu.hidden = true;
  userBtn.setAttribute('aria-expanded', 'false');
  resetReading();
  session.stopPolling();
  session.clearSession();
  api.clearCache();
  outlet.replaceChildren();
  outlet.hidden = false;
  okumaSection.hidden = true;
  navRole = null;
  lastBadge = 0;
}

function onUnauthorized() {
  if (phase === 'login' || phase === 'boot') {
    if (phase === 'boot') showLogin();
    return;
  }
  // Keep the address: after signing in again the user lands where they were.
  leaveApp();
  showLogin({ kind: 'info', text: 'Oturumunuz sona erdi. Devam etmek için yeniden giriş yapın.' });
}

async function logout() {
  await api.logout();
  leaveApp();
  history.replaceState(null, '', '#/');
  showLogin({ kind: 'ok', text: 'Çıkış yaptınız.' });
}

let lastUnread = 0;
function updateBell(n, animate = true) {
  const bell = $('bell');
  const badge = $('bell-badge');
  if (!bell || !badge) return;
  badge.hidden = n <= 0;
  badge.textContent = n > 99 ? '99+' : fmtCount(n);
  bell.setAttribute('aria-label', n > 0 ? `Bildirimler, ${fmtCount(n)} okunmamış` : 'Bildirimler');
  if (animate && n > lastUnread) replay(badge, 'bump');
  lastUnread = n;
}

session.onSessionChange(({ user, pending, unread }) => {
  if (!user || phase !== 'app') return;
  updateUserButton(user);
  updateBell(unread);
  if (user.rol !== navRole) {
    renderNav();
    const route = currentRoute();
    if (route?.def.roles && !route.def.roles.includes(user.rol)) reload();
  } else {
    updateBadge(pending);
  }
});

// ---------- Start ----------

function showBootError(r) {
  phase = 'login';
  showAuth();
  setPageTitle('Bağlantı yok');
  auth.replaceChildren(
    el(
      'div',
      { className: 'auth-center' },
      el(
        'div',
        { className: 'auth-card' },
        el('h1', { tabindex: '-1', text: 'Sunucuya ulaşılamadı' }),
        el('p', { className: 'auth-sub', text: r?.error?.mesaj ?? 'Beklenmeyen bir hata oluştu.' }),
        el('button', { className: 'btn btn-primary btn-block', type: 'button', text: 'Tekrar dene', onClick: start }),
      ),
    ),
  );
}

async function start() {
  phase = 'boot';
  const r = await session.refreshMe();
  if (r.ok) {
    if (session.currentUser()?.sifreDegismeli) showPasswordChange();
    else enterApp();
  } else if (r.unauthorized || r.error?.durum === 401) {
    if (phase !== 'login') showLogin();
  } else {
    showBootError(r);
  }
}

api.onUnauthorized(onUnauthorized);
initFileTarget();
setInterval(() => {
  if (!document.hidden) tickClocks();
}, 1000);
start();
