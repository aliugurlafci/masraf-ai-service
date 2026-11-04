// Display formatting helpers (pure; no clock access).

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '-';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : dateTimeFormat.format(ms);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) {
    return '-';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : timeFormat.format(ms);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) {
    return '-';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit] ?? 'B'}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return '-';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${(ms / 1000).toFixed(totalSeconds < 10 ? 1 : 0)} s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '-';
  }
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toLocaleString();
}

/** `timed_out` => `timed out`. */
export function humanize(value: string | null | undefined): string {
  return value ? value.replaceAll('_', ' ') : '-';
}

/** First 8 hex characters of a GUID (display only). */
export function shortId(id: string | null | undefined): string {
  if (!id) {
    return '-';
  }
  return id.replaceAll('-', '').slice(0, 8);
}

export function stringifyJson(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[value cannot be displayed]';
  }
}

const textEncoder = new TextEncoder();

export function utf8Length(value: string): number {
  return textEncoder.encode(value).length;
}
