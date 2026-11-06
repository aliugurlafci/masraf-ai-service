// Addresses that lead nowhere, and pages the user's role does not open.

import { el, ICONS } from '../dom.js';
import { btn, emptyState, pageHead } from '../ui.js';

export const notFoundView = {
  mount(root) {
    root.append(
      el(
        'div',
        { className: 'page narrow' },
        pageHead({ title: 'Sayfa bulunamadı' }),
        emptyState({ icon: ICONS.search, title: 'Bu adreste bir sayfa yok.', text: 'Bağlantı eski ya da eksik olabilir.', action: btn('Göstergeye dön', { href: '#/', kind: 'primary' }) }),
      ),
    );
  },
};

export const forbiddenView = {
  mount(root) {
    root.append(
      el(
        'div',
        { className: 'page narrow' },
        pageHead({ title: 'Bu sayfayı açma yetkiniz yok' }),
        emptyState({ icon: ICONS.ban, title: 'Bu sayfa başka bir rol için.', text: 'Erişmeniz gerekiyorsa yöneticinizden rolünüzü değiştirmesini isteyin.', action: btn('Göstergeye dön', { href: '#/', kind: 'primary' }) }),
      ),
    );
  },
};
