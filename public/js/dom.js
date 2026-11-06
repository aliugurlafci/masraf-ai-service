// DOM helpers. Text always goes in through textContent or text nodes, never as HTML.

export const $ = (id) => document.getElementById(id);

/**
 * el('p', { className: 'x', text: 'y', 'aria-label': 'z', onClick: fn }, child, ...)
 * Keys starting with "on" whose value is a function become event listeners.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === 'function' && key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Line icon on a 20×20 grid; stroke styles come from CSS. */
export function icon(d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export const ICONS = {
  check: 'M5 10.5l3.2 3.2L15 7',
  warn: 'M10 3.5l7 13H3zM10 8.5v3.5M10 14.6v.1',
  clock: 'M10 4.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11zM10 7.4V10l1.8 1.2',
  stack: 'M4.5 8h11M5.5 8v7.5h9V8M8 11h4M6 4.5h8',
  alert: 'M10 5.5v5.5M10 14.4v.1',
  sheet: 'M6.5 3.5h5l3 3v10h-8zM11.5 3.5v3h3',
  // Shell and actions
  home: 'M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z',
  receipt: 'M5 3h10v14l-1.7-1.2L11.7 17 10 15.8 8.3 17l-1.6-1.2L5 17zM8 7h4M8 10.5h4',
  plus: 'M10 4v12M4 10h12',
  inbox: 'M3.5 11h3.5l1 2h4l1-2h3.5M3.5 11l2-6.5h9l2 6.5v5h-13z',
  scan: 'M3.5 7V4.5a1 1 0 0 1 1-1H7M13 3.5h2.5a1 1 0 0 1 1 1V7M16.5 13v2.5a1 1 0 0 1-1 1H13M7 16.5H4.5a1 1 0 0 1-1-1V13M3.5 10h13',
  layers: 'M10 3 3 6.5 10 10l7-3.5zM3 10l7 3.5 7-3.5M3 13.5 10 17l7-3.5',
  users: 'M7.5 9a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.5 16c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5M13 3.8a2.6 2.6 0 0 1 0 5.1M14.6 11.7c1.8.5 2.9 2 2.9 4.3',
  flow: 'M3.5 4h5v4h-5zM11.5 12h5v4h-5zM8.5 6h3a2 2 0 0 1 2 2v4',
  tag: 'M3.5 3.5h6l7 7-6 6-7-7zM7 7h.1',
  log: 'M6 4H4.5v13h11V4H14M7.5 3h5v2.5h-5zM7.5 9h5M7.5 12h5M7.5 15h3',
  user: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5',
  logout: 'M8 4H4.5v12H8M12 6.5 15.5 10 12 13.5M15.5 10H8',
  key: 'M12.5 3.5a4 4 0 1 1-3.6 5.8L3.5 14.7v1.8H6V15h1.5v-1.5H9l1.1-1.1M13.5 6.5h.1',
  menu: 'M3.5 6h13M3.5 10h13M3.5 14h13',
  close: 'M5 5l10 10M15 5 5 15',
  search: 'M8.5 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12.2 12.2l4.3 4.3',
  chevronRight: 'M8 4.5 13.5 10 8 15.5',
  chevronLeft: 'M12 4.5 6.5 10l5.5 5.5',
  chevronDown: 'M5 7.5l5 5 5-5',
  arrowUp: 'M10 16V4M5 9l5-5 5 5',
  arrowDown: 'M10 4v12M5 11l5 5 5-5',
  arrowLeft: 'M16 10H4M9 5l-5 5 5 5',
  trash: 'M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6M8.5 9v5M11.5 9v5',
  edit: 'M12.5 4.5l3 3L7 16H4v-3zM11 6l3 3',
  send: 'M3.5 10 16.5 4 12 16.5l-2.5-5zM9.5 11.5 16.5 4',
  undo: 'M7 5.5 3.5 9 7 12.5M3.5 9H12a4 4 0 0 1 0 8h-2',
  ban: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM5.4 5.4l9.2 9.2',
  checkCircle: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7 10.2l2 2 4-4.2',
  xCircle: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.7 7.7l4.6 4.6M12.3 7.7l-4.6 4.6',
  cash: 'M2.5 5.5h15v9h-15zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 8v.1M15 12v.1',
  transfer: 'M4 7h11M12 4l3 3-3 3M16 13H5M8 10l-3 3 3 3',
  external: 'M11 3.5h5.5V9M16.5 3.5 9 11M14 12v4.5H3.5V6H8',
  download: 'M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16h12',
  upload: 'M10 13V3M5.5 7.5 10 3l4.5 4.5M4 13v3h12v-3',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  refresh: 'M15.5 9.5A5.5 5.5 0 1 1 13.9 6M15.5 3.5V6.5H12.5',
  eye: 'M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  eyeOff: 'M3 3l14 14M8.3 5.2c.5-.1 1.1-.2 1.7-.2 4.8 0 7.5 5 7.5 5a12 12 0 0 1-2 2.6M6.1 6.2C3.8 7.6 2.5 10 2.5 10s2.7 5 7.5 5c1.4 0 2.6-.4 3.6-1M8.6 8.6a2 2 0 0 0 2.8 2.8',
  info: 'M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM10 9v4.5M10 6.6v.1',
  calendar: 'M4 5h12v11.5H4zM4 8.5h12M7.5 3v3.5M12.5 3v3.5',
  dots: 'M5 10h.1M10 10h.1M15 10h.1',
  sun: 'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1',
  moon: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
  monitor: 'M3 4.5h14v9H3zM7.5 16.5h5M10 13.5v3',
};

/** Restarts a CSS animation class on a node that may already have it. */
export function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
