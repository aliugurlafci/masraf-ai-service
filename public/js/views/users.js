// Kullanıcılar (yonetici): list with search and filters, add / edit (including the approval flow
// the user's expenses go to), activate / deactivate and password reset. The server's 409 messages
// (son_yonetici, onay_akisinda, bekleyen_onay_var, eposta_kullaniliyor) are shown as they come.
// #/kullanicilar?akis=<id> opens filtered to the users whose expenses go to that flow.

import * as api from '../api.js';
import { listSearch, multiSelect, searchSelect } from '../combo.js';
import { el, icon, ICONS } from '../dom.js';
import { fmtCount, fmtCurrency, fmtDateTime, fmtRelative } from '../format.js';
import { limitText, ROLE_HINTS, roleLabel, ROLES, STRATEGY_LABEL } from '../labels.js';
import { href, navigate } from '../router.js';
import * as session from '../session.js';
import {
  actionDialog,
  applyFieldErrors,
  avatar,
  btn,
  debounce,
  emptyState,
  field,
  fieldset,
  input,
  loadFailed,
  messageDialog,
  openDialog,
  pageHead,
  select,
  setFieldError,
  skeletonList,
  toast,
} from '../ui.js';
import { passwordField } from './login.js';

/** 12 characters without look-alikes (0/O, 1/l/I), with at least one digit and one letter. */
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint32Array(12));
    const out = [...bytes].map((b) => all[b % all.length]).join('');
    if (/\d/.test(out) && /[a-z]/i.test(out)) return out;
  }
}

const HELP_LINKS = {
  onay_akisinda: [{ label: 'Onay akışlarını düzenle', href: '#/onay-akisi' }],
  bekleyen_onay_var: [{ label: 'Onaydaki masraflar (devretmek için)', href: '#/tum-masraflar?durum=onayda' }],
};

const flowHref = (id) => href('/onay-akisi', { akis: id });

/** Gösterim of an organisation: "kod – ad" (docs section 6). */
const orgLabel = (o) => (o.ad && o.ad !== o.kod ? `${o.kod} – ${o.ad}` : o.kod);
const costLabel = (m) => m.gosterim ?? m.kod;

/** Where to fix a refusal; for onay_akisinda one link per flow the user approves in. */
function helpLinks(error, u) {
  if (error.kod === 'onay_akisinda' && u.onaycilik?.length) {
    return u.onaycilik.map((o) => ({ label: `“${o.akis.ad}” akışını düzenle`, href: flowHref(o.akis.id) }));
  }
  return HELP_LINKS[error.kod] ?? [];
}

export const usersView = {
  mount(root, { route, signal }) {
    let users = [];
    let flows = null; // Akis[] (default first); null when the list could not be loaded
    let base = session.knownBaseCurrency() ?? 'TRY';
    const filters = { q: '', aktif: 'aktif', rol: '', akis: route.query.get('akis') ?? '' };

    const search = input({ type: 'search', placeholder: 'Ad, e-posta ya da departman ara', 'aria-label': 'Kullanıcı ara' });
    const statusSeg = el(
      'div',
      { className: 'seg', role: 'group', 'aria-label': 'Duruma göre' },
      ...[
        ['aktif', 'Aktif'],
        ['pasif', 'Pasif'],
        ['tumu', 'Tümü'],
      ].map(([v, l]) => el('button', { type: 'button', 'data-v': v, 'aria-pressed': String(filters.aktif === v), text: l })),
    );
    const roleSelect = select([{ value: '', label: 'Tüm roller' }, ...Object.entries(ROLES).map(([v, l]) => ({ value: v, label: l }))], { 'aria-label': 'Role göre' });
    const flowSelect = select([{ value: '', label: 'Tüm akışlar' }], { 'aria-label': 'Masraflarının gittiği onay akışına göre', hidden: true });
    const announcer = el('p', { className: 'visually-hidden', role: 'status' });
    const list = el('div', { className: 'results' }, skeletonList(5));

    root.append(
      el(
        'div',
        { className: 'page' },
        pageHead({ title: 'Kullanıcılar', sub: 'Hesaplar, roller, organizasyon ve masraf merkezleri, masraflarının gittiği onay akışı ve onaycı oldukları akışlar.', actions: [btn('Kullanıcı ekle', { icon: ICONS.plus, kind: 'primary', onClick: () => editUser(null) })] }),
        el('div', { className: 'toolbar' }, el('label', { className: 'search' }, icon(ICONS.search), search), statusSeg, roleSelect, flowSelect),
        announcer,
        list,
      ),
    );

    search.addEventListener('input', debounce(() => {
      filters.q = search.value.trim();
      render();
    }, 200));
    statusSeg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      filters.aktif = b.dataset.v;
      for (const x of statusSeg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      render();
    });
    roleSelect.addEventListener('change', () => {
      filters.rol = roleSelect.value;
      render();
    });
    flowSelect.addEventListener('change', () => {
      filters.akis = flowSelect.value;
      // The address follows the filter (history.replaceState: no new entry, the view stays as it is).
      history.replaceState(history.state, '', href('/kullanicilar', { akis: filters.akis }));
      render();
    });

    const defaultFlow = () => flows?.find((f) => f.varsayilan) ?? null;

    function fillFlowFilter() {
      if (!flows) {
        filters.akis = ''; // no list to show the choice with: do not filter silently
        return;
      }
      flowSelect.replaceChildren(el('option', { value: '', text: 'Tüm akışlar' }), ...flows.map((f) => el('option', { value: f.id, text: f.varsayilan ? `${f.ad} (varsayılan)` : f.ad })));
      if (filters.akis && !flows.some((f) => String(f.id) === filters.akis)) filters.akis = '';
      flowSelect.value = filters.akis;
      // With a single flow there is nothing to choose; the filter appears once there are several.
      flowSelect.hidden = flows.length < 2 && !filters.akis;
    }

    async function load() {
      const [r, fl] = await Promise.all([api.listUsers({}, { signal }), api.listFlows({ signal })]);
      if (signal.aborted) return;
      flows = fl.ok && Array.isArray(fl.body) ? fl.body : null;
      if (flows?.[0]?.paraBirimi) session.setBaseCurrency(flows[0].paraBirimi);
      base = session.knownBaseCurrency() ?? (await session.loadBaseCurrency());
      if (signal.aborted) return;
      if (!r.ok) {
        if (!r.unauthorized) list.replaceChildren(loadFailed(r, load));
        return;
      }
      users = Array.isArray(r.body) ? r.body : [];
      fillFlowFilter();
      render();
    }

    function visible() {
      const q = filters.q.toLocaleLowerCase('tr-TR');
      return users.filter((u) => {
        if (filters.aktif === 'aktif' && !u.aktif) return false;
        if (filters.aktif === 'pasif' && u.aktif) return false;
        if (filters.rol && u.rol !== filters.rol) return false;
        if (filters.akis && String(u.onayAkisi?.id ?? '') !== filters.akis) return false;
        if (!q) return true;
        return [u.adSoyad, u.eposta, u.departman, u.organizasyon?.ad, u.organizasyon?.kod].some((s) => (s ?? '').toLocaleLowerCase('tr-TR').includes(q));
      });
    }

    function render() {
      const rows = visible();
      announcer.textContent = `${fmtCount(rows.length)} kullanıcı`;
      if (rows.length === 0) {
        list.replaceChildren(
          users.length === 0
            ? emptyState({ icon: ICONS.users, title: 'Henüz kullanıcı yok' })
            : emptyState({ icon: ICONS.search, title: 'Bu filtreye uyan kullanıcı yok', text: 'Aramayı ya da filtreleri değiştirin.' }),
        );
        return;
      }
      const me = session.currentUser();
      const tbody = el('tbody', { className: 'stagger' });
      for (const u of rows) {
        tbody.append(
          el(
            'tr',
            { className: u.aktif ? '' : 'is-off', 'data-id': u.id },
            el(
              'td',
              { className: 't-main' },
              el(
                'div',
                { className: 'cell-main' },
                avatar(u.adSoyad),
                el(
                  'div',
                  { className: 'cell-text' },
                  el('span', { className: 'cell-title' }, el('span', { text: u.adSoyad }), me?.id === u.id ? el('span', { className: 'tag', text: 'Siz' }) : null),
                  el('span', { className: 'cell-sub', text: u.eposta }),
                ),
              ),
            ),
            el('td', { 'data-label': 'Rol' }, el('span', { className: `role-badge ${u.rol}`, text: roleLabel(u.rol) })),
            el('td', { 'data-label': 'Departman', text: u.departman || '—' }),
            el('td', { className: 't-org', 'data-label': 'Organizasyon' }, orgCell(u)),
            el('td', { className: 't-flow', 'data-label': 'Onay akışı' }, flowCell(u)),
            el('td', { 'data-label': 'Durum' }, el('span', { className: 'chips' }, el('span', { className: `status ${u.aktif ? 'ok' : 'off'} sm` }, icon(u.aktif ? ICONS.check : ICONS.ban), el('span', { text: u.aktif ? 'Aktif' : 'Pasif' })), u.sifreDegismeli ? el('span', { className: 'tag warn', title: 'İlk girişte şifresini değiştirecek', text: 'Şifre bekliyor' }) : null)),
            el('td', { 'data-label': 'Son giriş' }, u.sonGiris ? el('time', { datetime: u.sonGiris, title: fmtDateTime(u.sonGiris), text: fmtRelative(u.sonGiris) }) : el('span', { className: 'muted', text: 'Hiç' })),
            el(
              'td',
              { className: 't-actions' },
              btn('Düzenle', { icon: ICONS.edit, size: 'sm', iconOnly: true, onClick: () => editUser(u), attrs: { 'data-act': 'edit', 'aria-label': `${u.adSoyad}: düzenle` } }),
              btn('Şifre sıfırla', { icon: ICONS.key, size: 'sm', iconOnly: true, onClick: () => resetPassword(u), attrs: { 'data-act': 'password', 'aria-label': `${u.adSoyad}: şifre sıfırla` } }),
              // Your own account cannot be deactivated (409 kendi_hesabi), so the button is not offered.
              me?.id === u.id ? null : btn(u.aktif ? 'Pasif yap' : 'Aktif yap', { size: 'sm', kind: u.aktif ? 'danger-ghost' : 'ghost', onClick: () => toggleActive(u), attrs: { 'data-act': 'toggle', 'aria-label': `${u.adSoyad}: ${u.aktif ? 'pasif yap' : 'aktif yap'}` } }),
            ),
          ),
        );
      }
      list.replaceChildren(
        el(
          'div',
          { className: 'table-card' },
          // Narrow desktop widths scroll the table sideways instead of clipping the action buttons.
          el(
            'div',
            { className: 'table-scroll' },
            el(
              'table',
              { className: 'data-table user-table' },
              el('caption', { className: 'visually-hidden', text: 'Kullanıcılar' }),
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', { scope: 'col', text: 'Kullanıcı' }),
                  el('th', { scope: 'col', text: 'Rol' }),
                  el('th', { scope: 'col', text: 'Departman' }),
                  el('th', { scope: 'col', text: 'Organizasyon' }),
                  el('th', { scope: 'col', text: 'Onay akışı' }),
                  el('th', { scope: 'col', text: 'Durum' }),
                  el('th', { scope: 'col', text: 'Son giriş' }),
                  el('th', { scope: 'col' }, el('span', { className: 'visually-hidden', text: 'İşlemler' })),
                ),
              ),
              tbody,
            ),
          ),
        ),
      );
    }

    /** "“Genel” akışında 1. onaycı (zincirleme onay); onay limiti ₺5.000,00". */
    function approverTitle(o) {
      const strategy = STRATEGY_LABEL[o.akis.strateji];
      const limit = o.limit === null || o.limit === undefined ? 'son onaycı, limiti sınırsız' : `onay limiti ${fmtCurrency(o.limit, base)}`;
      return `“${o.akis.ad}” akışında ${o.sira}. onaycı${strategy ? ` (${strategy.toLocaleLowerCase('tr-TR')})` : ''}; ${limit}`;
    }

    /** The organisation, and how many cost centres the user may choose from. */
    function orgCell(u) {
      const org = u.organizasyon;
      const n = Array.isArray(u.masrafMerkezleri) ? u.masrafMerkezleri.length : 0;
      const centres = n > 0 ? `${fmtCount(n)} masraf merkezi` : 'Masraf merkezi yok';
      const title = n > 0 ? u.masrafMerkezleri.map(costLabel).join(', ') : null;
      return el(
        'div',
        { className: 'cell-text' },
        org ? el('span', { className: 'cell-title' }, el('span', { text: org.ad || org.kod }), org.aktif === false ? el('span', { className: 'tag', text: 'Pasif' }) : null) : el('span', { className: 'muted', text: '—' }),
        el('span', { className: 'cell-sub', title, text: org && org.ad && org.ad !== org.kod ? `${org.kod} · ${centres}` : centres }),
      );
    }

    /** The flow the user's expenses go to, and the flows they approve in (order and limit). */
    function flowCell(u) {
      const own = u.onayAkisi
        ? el(
            'span',
            { className: 'flow-own' },
            el('a', { className: 'flow-link', href: flowHref(u.onayAkisi.id), title: 'Masraflarının gittiği akış', text: u.onayAkisi.ad }),
            u.onayAkisiId === null ? el('span', { className: 'muted small', title: 'Akış atanmadı; varsayılan akışı izler', text: 'varsayılan' }) : null,
          )
        : el('span', { className: 'muted', text: '—' });
      const approves = u.onaycilik ?? [];
      if (approves.length === 0) return own;
      return el(
        'div',
        { className: 'flow-cell' },
        own,
        el(
          'ul',
          { className: 'approver-of', 'aria-label': 'Onaycı olduğu akışlar' },
          ...approves.map((o) =>
            el(
              'li',
              { className: 'range-badge', title: approverTitle(o) },
              // Two parts that each stay on one line: "Satış 1." and "limit 10.000,00" (or "sınırsız").
              el('span', { className: 'rb-part' }, el('span', { className: 'rb-flow', text: o.akis.ad }), el('strong', { text: `${o.sira}.` }), el('span', { className: 'visually-hidden', text: ' onaycı,' })),
              el('span', { className: 'rb-part' }, el('span', { text: limitText(o.limit, null) }), o.limit === null || o.limit === undefined ? null : el('span', { className: 'visually-hidden', text: ` ${base}` })),
            ),
          ),
        ),
      );
    }

    function replaceUser(updated, act = null) {
      const i = users.findIndex((u) => u.id === updated.id);
      if (i >= 0) users[i] = updated;
      else users.push(updated);
      users.sort((a, b) => a.adSoyad.localeCompare(b.adSoyad, 'tr'));
      render();
      // The row was drawn again, so the button that opened the dialog is gone: focus its successor.
      if (act) (list.querySelector(`tr[data-id="${updated.id}"] [data-act="${act}"]`) ?? search).focus();
    }

    /** After changing yourself: the menu and access follow the new role. */
    async function afterSelfChange(updated) {
      const me = session.currentUser();
      if (me?.id !== updated.id) return;
      await session.refreshMe();
      if (!session.isManager()) navigate('/');
    }

    // ---------- Add / edit ----------

    /**
     * The "Onay akışı" select of the user dialog. value(): null (follow the default flow), a flow id,
     * or undefined when the flows could not be loaded (the field is then left out of the request).
     */
    function flowSelectFor(u) {
      if (!flows || flows.length === 0) {
        return {
          field: el('p', { className: 'hint dlg-note', text: 'Onay akışları yüklenemedi; kullanıcının akışı değiştirilmeden kaydedilir.' }),
          control: null,
          value: () => undefined,
        };
      }
      const current = u?.onayAkisiId ?? null;
      const options = [{ value: '', label: `Varsayılan akış (şu an: ${defaultFlow()?.ad ?? '—'})` }, ...flows.map((f) => ({ value: String(f.id), label: f.ad }))];
      if (current !== null && !flows.some((f) => f.id === current)) options.push({ value: String(current), label: u.onayAkisi?.ad ?? `Akış ${current}` });
      const control = select(options, { name: 'onayAkisiId', value: current === null ? '' : String(current) });
      control.addEventListener('change', () => setFieldError(control, null));
      return {
        field: field({
          label: 'Onay akışı',
          input: control,
          hint: 'Masraflarının gideceği akış. "Varsayılan akış" seçilirse varsayılan değiştiğinde kullanıcı yenisine geçer; bir akışı adıyla seçerseniz o akışta kalır.',
        }),
        control,
        value: () => (control.value === '' ? null : Number(control.value)),
      };
    }

    function editUser(u) {
      const creating = !u;
      const email = input({ type: 'email', name: 'eposta', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', value: u?.eposta ?? '', required: true });
      const name = input({ name: 'adSoyad', autocomplete: 'off', value: u?.adSoyad ?? '', required: true, maxlength: 120 });
      const dept = input({ name: 'departman', autocomplete: 'off', value: u?.departman ?? '', maxlength: 120 });
      const roleGroup = el('div', { className: 'role-options' });
      for (const [value, label] of Object.entries(ROLES)) {
        roleGroup.append(
          el(
            'label',
            { className: 'role-option' },
            el('input', { type: 'radio', name: 'rol', value, checked: (u?.rol ?? 'calisan') === value }),
            el('span', { className: 'role-text' }, el('span', { className: 'role-title', text: label }), el('span', { className: 'role-hint', text: ROLE_HINTS[value] })),
          ),
        );
      }
      const roleSet = fieldset({ legend: 'Rol', content: roleGroup });
      const flowPick = flowSelectFor(u);
      // Only active records can be newly chosen; an inactive one the user already has is kept and shown.
      const orgPick = searchSelect({
        value: u?.organizasyon ? { id: u.organizasyon.id, label: orgLabel(u.organizasyon), inactive: u.organizasyon.aktif === false } : null,
        placeholder: 'Organizasyon arayın…',
        label: 'Organizasyonlar',
        search: listSearch(api.listOrganizations, (o) => ({ id: o.id, label: orgLabel(o), sub: o.paraBirimi ?? null })),
        onChange: () => setFieldError(orgPick.input, null),
      });
      const savedCentres = (u?.masrafMerkezleri ?? []).map((m) => ({ id: m.id, label: costLabel(m), inactive: m.aktif === false }));
      const centresPick = multiSelect({
        values: savedCentres,
        label: 'Masraf merkezleri',
        placeholder: 'Masraf merkezi arayın ve ekleyin…',
        max: 100,
        search: listSearch(api.listCostCentres, (m) => ({ id: m.id, label: costLabel(m) })),
        onChange: () => setFieldError(centresPick.input, null),
      });
      let pw = null;
      const body = [
        field({ label: 'Ad soyad', input: name }),
        field({ label: 'E-posta', input: email }),
        field({ label: 'Departman', input: dept, optional: true }),
        roleSet,
        flowPick.field,
        field({ label: 'Organizasyon', input: orgPick.input, control: orgPick.node, optional: true, hint: 'Kullanıcının masrafları bu organizasyona yazılır.' }),
        field({
          label: 'Masraf merkezleri',
          input: centresPick.input,
          control: centresPick.node,
          optional: true,
          hint: 'Kullanıcı masraf formunda bunlardan birini seçer; tek merkez varsa kendiliğinden seçilir. Pasif merkez korunur ama yeni seçimde kullanılamaz.',
        }),
      ];
      if (creating) {
        pw = passwordField('Geçici şifre', { name: 'sifre', autocomplete: 'new-password', value: generatePassword() }, 'Kullanıcı ilk girişte bu şifreyi değiştirecek.');
        pw.field.querySelector('.pw-toggle').click(); // start visible: the admin passes it on
        const gen = btn('Yeni şifre üret', { size: 'sm', kind: 'ghost', icon: ICONS.refresh, onClick: () => (pw.input.value = generatePassword()) });
        body.push(pw.field, gen);
      }
      for (const c of [email, name, dept]) c.addEventListener('input', () => setFieldError(c, null));

      openDialog({
        title: creating ? 'Kullanıcı ekle' : 'Kullanıcıyı düzenle',
        description: creating ? null : u.eposta,
        body,
        submitLabel: creating ? 'Kullanıcıyı ekle' : 'Kaydet',
        onSubmit: async (ctl) => {
          const data = {
            eposta: email.value.trim(),
            adSoyad: name.value.trim(),
            rol: roleGroup.querySelector('input:checked')?.value ?? 'calisan',
            departman: dept.value.trim() || null,
          };
          let bad = false;
          if (!data.adSoyad) {
            setFieldError(name, 'Ad soyad girin.');
            bad = true;
          }
          if (!data.eposta || !data.eposta.includes('@')) {
            setFieldError(email, 'Geçerli bir e-posta adresi girin.');
            bad = true;
          }
          if (creating && !pw.input.value) {
            setFieldError(pw.input, 'Geçici şifre girin.');
            bad = true;
          }
          if (bad) {
            ctl.form.querySelector('[aria-invalid="true"]')?.focus();
            return false;
          }
          let r;
          const flowId = flowPick.value(); // undefined: the list did not load, the field is not sent
          const orgId = orgPick.value()?.id ?? null;
          const centreIds = centresPick.values().map((c) => c.id);
          if (creating) {
            r = await api.createUser({
              ...data,
              departman: data.departman ?? undefined,
              sifre: pw.input.value,
              onayAkisiId: flowId,
              organizasyonId: orgId ?? undefined,
              masrafMerkeziIdler: centreIds.length > 0 ? centreIds : undefined,
            });
          } else {
            const patch = {};
            if (data.eposta !== u.eposta) patch.eposta = data.eposta;
            if (data.adSoyad !== u.adSoyad) patch.adSoyad = data.adSoyad;
            if (data.rol !== u.rol) patch.rol = data.rol;
            if ((data.departman ?? null) !== (u.departman ?? null)) patch.departman = data.departman;
            if (flowId !== undefined && flowId !== (u.onayAkisiId ?? null)) patch.onayAkisiId = flowId;
            if (orgId !== (u.organizasyon?.id ?? null)) patch.organizasyonId = orgId;
            // The list is the user's whole set; the order does not matter.
            const before = savedCentres.map((c) => c.id);
            if (centreIds.length !== before.length || centreIds.some((x) => !before.includes(x))) patch.masrafMerkeziIdler = centreIds;
            if (Object.keys(patch).length === 0) return { ok: true, body: u };
            r = await api.updateUser(u.id, patch);
          }
          if (r.ok) return r;
          if (r.unauthorized) return null;
          if (r.error.kod === 'eposta_kullaniliyor') {
            setFieldError(email, r.error.mesaj);
            email.focus();
            return false;
          }
          // alanlar["masrafMerkeziIdler.<i>"] names the i-th centre sent: the message goes under the list with its name.
          const alanlar = { ...(r.error.alanlar ?? {}) };
          const centreMsgs = [];
          for (const [k, msg] of Object.entries(alanlar)) {
            const m = /^masrafMerkeziIdler(?:\.(\d+))?$/.exec(k);
            if (!m) continue;
            delete alanlar[k];
            const c = m[1] !== undefined ? centresPick.values()[Number(m[1])] : null;
            centreMsgs.push(c ? `${c.label}: ${msg}` : String(msg));
          }
          if (centreMsgs.length > 0) {
            setFieldError(centresPick.input, centreMsgs.join(' '));
            centresPick.input.focus();
          }
          const leftovers = r.error.alanlar
            ? applyFieldErrors(alanlar, { eposta: email, adSoyad: name, departman: dept, rol: roleSet, sifre: pw?.input, onayAkisiId: flowPick.control, organizasyonId: orgPick.input })
            : [r.error.mesaj];
          if (leftovers.length > 0) ctl.setError(leftovers.join(' '));
          return false;
        },
      }).done.then(async (r) => {
        if (!r || r === true) return;
        replaceUser(r.body, creating ? null : 'edit');
        if (creating) {
          const password = pw.input.value;
          toast(`${r.body.adSoyad} eklendi.`, 'ok');
          showPassword(r.body, password, 'Kullanıcı eklendi');
        } else {
          toast('Kullanıcı güncellendi.', 'ok');
          afterSelfChange(r.body);
        }
      });
    }

    /** Shows a temporary password once, with a copy button. */
    function showPassword(u, password, title) {
      const value = el('code', { className: 'secret', text: password });
      const copy = btn('Kopyala', {
        icon: ICONS.copy,
        size: 'sm',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(password);
            copy.querySelector('span').textContent = 'Kopyalandı';
          } catch {
            toast('Panoya kopyalanamadı; şifreyi elle seçin.', 'err');
          }
        },
      });
      openDialog({
        title,
        description: `${u.adSoyad} (${u.eposta}) ilk girişte bu geçici şifreyi kullanacak ve yenisini belirleyecek. Şifreyi güvenli bir yoldan iletin; bu pencere kapanınca yeniden gösterilmez.`,
        body: [el('div', { className: 'secret-row' }, value, copy)],
      });
    }

    // ---------- Password reset ----------

    function resetPassword(u) {
      const pw = passwordField('Yeni geçici şifre', { name: 'yeniSifre', autocomplete: 'new-password', value: generatePassword() }, 'Kullanıcının açık oturumları kapanır; ilk girişte şifresini değiştirir.');
      pw.field.querySelector('.pw-toggle').click(); // start visible: the admin passes it on
      const gen = btn('Yeni şifre üret', { size: 'sm', kind: 'ghost', icon: ICONS.refresh, onClick: () => (pw.input.value = generatePassword()) });
      openDialog({
        title: 'Şifre sıfırla',
        description: `${u.adSoyad} için geçici bir şifre belirlenecek.`,
        body: [pw.field, gen],
        submitLabel: 'Şifreyi sıfırla',
        submitIcon: ICONS.key,
        onSubmit: async (ctl) => {
          if (!pw.input.value) {
            setFieldError(pw.input, 'Şifre girin.');
            pw.input.focus();
            return false;
          }
          const r = await api.resetUserPassword(u.id, pw.input.value);
          if (r.ok) return pw.input.value;
          if (r.unauthorized) return null;
          if (r.error.alanlar?.yeniSifre) {
            setFieldError(pw.input, r.error.alanlar.yeniSifre);
            pw.input.focus();
          } else {
            ctl.setError(r.error.mesaj);
          }
          return false;
        },
      }).done.then((password) => {
        if (typeof password !== 'string') return;
        replaceUser({ ...u, sifreDegismeli: true }, 'password');
        showPassword(u, password, 'Şifre sıfırlandı');
      });
    }

    // ---------- Active / inactive ----------

    async function toggleActive(u) {
      const next = !u.aktif;
      let failure = null;
      const r = await actionDialog({
        title: next ? 'Kullanıcıyı aktif yap' : 'Kullanıcıyı pasif yap',
        message: next ? `${u.adSoyad} yeniden giriş yapabilecek.` : `${u.adSoyad} giriş yapamayacak ve açık oturumları kapanacak. Masrafları ve geçmişi silinmez.`,
        confirmLabel: next ? 'Aktif yap' : 'Pasif yap',
        kind: next ? 'primary' : 'danger',
        run: async () => {
          const res = await api.updateUser(u.id, { aktif: next });
          if (!res.ok && ['son_yonetici', 'onay_akisinda', 'bekleyen_onay_var', 'kendi_hesabi'].includes(res.error.kod)) {
            failure = res.error;
            return { ok: true, body: null };
          }
          return res;
        },
      });
      if (failure) {
        messageDialog({ title: next ? 'Aktif yapılamadı' : 'Pasif yapılamadı', message: failure.mesaj, links: helpLinks(failure, u) });
        return;
      }
      if (!r?.body) return;
      replaceUser(r.body, 'toggle');
      toast(next ? 'Kullanıcı aktif yapıldı.' : 'Kullanıcı pasif yapıldı.', 'ok');
      afterSelfChange(r.body);
    }

    load();
  },
};
