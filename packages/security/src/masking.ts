const REDACTED = '[REDACTED]';

/** Case-insensitive exact key names whose values are always redacted by {@link maskObject} (§17.2). */
export const REDACT_KEYS: readonly string[] = Object.freeze([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'tokenhash',
  'csrftoken',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'set-cookie',
  'anthropic_api_key',
  'connectionstring',
  'privatekey',
]);

const REDACT_KEY_SET: ReadonlySet<string> = new Set(REDACT_KEYS);
const REDACT_KEY_SUFFIXES: readonly string[] = ['_password', 'password', '_secret', '_token'];

function isRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_SET.has(lower) || REDACT_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

// ---- linear-time rule engine -------------------------------------------------------------------
//
// Every rule finds its matches in O(n) for any input. Rules whose match needs a terminator after an
// unbounded run (closing quote, `}`, `@`, END marker) are not left to the backtracking engine, which
// rescans the rest of the text from every candidate start (O(n^2) on long lines without separators):
// a cheap global "prefix" regex finds the candidate starts and a hand-written completer looks for the
// terminator, memoising "no terminator after position p" so no region is scanned twice. Each
// completer reproduces exactly the match the documented `pattern` (exported as SECRET_VALUE_PATTERNS)
// would produce at the same start, so the masking output is unchanged.

interface MaskMatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

interface MaskRule {
  /** Documented global pattern (§17.2), exported through {@link SECRET_VALUE_PATTERNS}. */
  readonly pattern: RegExp;
  /** Non-overlapping matches, left to right, in linear time. */
  find(text: string): MaskMatch[];
}

/** Returned by a completer when no later candidate can match either (terminator absent for good). */
const STOP = Symbol('stop');
type Completer = (text: string, prefix: RegExpExecArray) => MaskMatch | null | typeof STOP;

function regexRule(
  pattern: RegExp,
  replace: (m: RegExpExecArray) => string = () => REDACTED,
): MaskRule {
  // One private instance per rule (find is synchronous and never re-entered); matchAll would clone
  // the regex on every call, which dominates the cost of masking many short lines.
  const re = new RegExp(pattern.source, pattern.flags);
  return {
    pattern,
    find(text) {
      const out: MaskMatch[] = [];
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        out.push({ start: m.index, end: m.index + m[0].length, replacement: replace(m) });
      }
      return out;
    },
  };
}

function scanRule(pattern: RegExp, prefix: RegExp, makeCompleter: () => Completer): MaskRule {
  const re = new RegExp(prefix.source, prefix.flags);
  return {
    pattern,
    find(text) {
      let complete: Completer | undefined;
      const out: MaskMatch[] = [];
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        complete ??= makeCompleter();
        const r = complete(text, m);
        if (r === STOP) break;
        if (r === null) {
          re.lastIndex = m.index + 1;
        } else {
          out.push(r);
          re.lastIndex = r.end;
        }
      }
      return out;
    },
  };
}

/** First index of `ch` at or after `from`, memoised for monotonically increasing `from`. */
function createNextIndex(): (text: string, ch: string, from: number) => number {
  const memo = new Map<string, { from: number; at: number }>();
  return (text, ch, from) => {
    const hit = memo.get(ch);
    if (hit && hit.from <= from && (hit.at === -1 || hit.at >= from)) return hit.at;
    const at = text.indexOf(ch, from);
    memo.set(ch, { from, at });
    return at;
  };
}

const UNQUOTED_VALUE = /[^\s;,&]+/y;

/** `("[^"]*"|'[^']*'|[^\s;,&]+)` after a `key = ` prefix (group 1 keeps the prefix). */
function keyValueCompleter(): Completer {
  const nextIndex = createNextIndex();
  return (text, m) => {
    const prefixText = m[1] ?? '';
    const v = m.index + m[0].length;
    const c = text[v];
    if (c === '"' || c === "'") {
      const close = nextIndex(text, c, v + 1);
      if (close >= 0) return { start: m.index, end: close + 1, replacement: prefixText + REDACTED };
    }
    UNQUOTED_VALUE.lastIndex = v;
    const run = UNQUOTED_VALUE.exec(text);
    if (run === null) return null;
    return { start: m.index, end: v + run[0].length, replacement: prefixText + REDACTED };
  };
}

/** `\{(?:[^}]|\}\})*\}`: the first odd run of `}` closes; without one the regex backtracks to the last pair. */
function bracedCompleter(): Completer {
  return (text, m) => {
    let j = text.indexOf('}', m.index + m[0].length);
    if (j < 0) return STOP;
    let lastPairEnd = -1;
    while (j >= 0) {
      let k = j;
      while (k < text.length && text.charCodeAt(k) === 0x7d) k += 1;
      if ((k - j) % 2 === 1) return { start: m.index, end: k, replacement: (m[1] ?? '') + REDACTED };
      lastPairEnd = k - 1;
      j = text.indexOf('}', k);
    }
    return { start: m.index, end: lastPairEnd, replacement: (m[1] ?? '') + REDACTED };
  };
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/**
 * JSON string body `(?:[^"\\]|\\.)*"`. A scan from v that fails at F also fails from every later
 * start in (v, F]: such a start follows a quote that the scan from v consumed as an escape, so both
 * scans continue in lockstep.
 */
function jsonStringCompleter(): Completer {
  let failFrom = -1;
  let failUntil = -1;
  return (text, m) => {
    const v = m.index + m[0].length;
    if (v > failFrom && v <= failUntil) return null;
    let i = v;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        return { start: m.index, end: i + 1, replacement: `${m[1] ?? ''}"${REDACTED}"` };
      }
      if (c === 0x5c) {
        if (i + 1 >= text.length || isLineTerminator(text.charCodeAt(i + 1))) break;
        i += 2;
      } else {
        i += 1;
      }
    }
    failFrom = v;
    failUntil = i;
    return null;
  };
}

/** Lazy `[\s\S]*?` up to the first END marker after the BEGIN marker. */
function pemCompleter(): Completer {
  const end = /-----END [A-Z ]*PRIVATE KEY-----/g;
  return (text, m) => {
    end.lastIndex = m.index + m[0].length;
    const e = end.exec(text);
    if (e === null) return STOP;
    return { start: m.index, end: e.index + e[0].length, replacement: REDACTED };
  };
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

function isSchemeChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x2d
  );
}

const URL_USER = /[^:/\s@]*/y;

/**
 * `[a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:[^@\s]+@` anchored on each `://`: the scheme is checked backwards
 * (never past the previous match), the password runs to the first `@` or whitespace (memoised).
 */
function urlCredentialCompleter(): Completer {
  let floor = 0;
  let stopFrom = -1;
  let stopAt = -1;
  const stopRe = /[@\s]/g;
  const nextStop = (text: string, from: number): number => {
    if (stopFrom >= 0 && stopFrom <= from && (stopAt === -1 || stopAt >= from)) return stopAt;
    stopRe.lastIndex = from;
    const s = stopRe.exec(text);
    stopFrom = from;
    stopAt = s === null ? -1 : s.index;
    return stopAt;
  };
  return (text, m) => {
    let first = -1;
    for (let j = m.index - 1; j >= floor; j -= 1) {
      const code = text.charCodeAt(j);
      if (!isSchemeChar(code)) break;
      if (isAsciiLetter(code)) first = j;
    }
    if (first < 0) return null;
    URL_USER.lastIndex = m.index + 3;
    const user = URL_USER.exec(text);
    const colon = m.index + 3 + (user === null ? 0 : user[0].length);
    if (text.charCodeAt(colon) !== 0x3a) return null;
    const stop = nextStop(text, colon + 1);
    if (stop < 0) return STOP;
    if (stop === colon + 1 || text.charCodeAt(stop) !== 0x40) return null;
    floor = stop + 1;
    return {
      start: first,
      end: stop + 1,
      replacement: `${text.slice(first, colon + 1)}${REDACTED}@`,
    };
  };
}

const prefixed = (m: RegExpExecArray): string => `${m[1] ?? ''}${REDACTED}`;

/**
 * Ordered rules (§17.2 plus defence-in-depth additions). Multi-line private keys first, then
 * provider tokens, then `key=value` / JSON / URL / cookie forms that keep their prefix.
 */
const MASK_RULES: readonly MaskRule[] = [
  scanRule(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    pemCompleter,
  ),
  regexRule(/sk-ant-[A-Za-z0-9_-]{20,}/g),
  regexRule(/orc_pat_[A-Za-z0-9_-]{43}/g),
  regexRule(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    (m) => `${m[1] ?? ''} ${REDACTED}`,
  ),
  regexRule(/\bAKIA[0-9A-Z]{16}\b/g),
  regexRule(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g),
  regexRule(/\bgithub_pat_[A-Za-z0-9_]{22,}/g),
  regexRule(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g),
  // ODBC/ADO brace-quoted values may contain ';' (`Password={a;b}`): mask the whole braced value first.
  scanRule(
    /\b((?:password|passwd|pwd)\s*=\s*)\{(?:[^}]|\}\})*\}/gi,
    /\b((?:password|passwd|pwd)\s*=\s*)\{/gi,
    bracedCompleter,
  ),
  scanRule(
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi,
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)/gi,
    keyValueCompleter,
  ),
  scanRule(
    /\b(aws_secret_access_key\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi,
    /\b(aws_secret_access_key\s*[=:]\s*)/gi,
    keyValueCompleter,
  ),
  // JSON text: "password": "..." / "access_token": "..." (the key=value rule cannot see past the quote).
  scanRule(
    /("(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token)|pwd|api[_-]?key|apikey|authorization|cookie|private_?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    /("(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token)|pwd|api[_-]?key|apikey|authorization|cookie|private_?key)"\s*:\s*)"/gi,
    jsonStringCompleter,
  ),
  // Documented form anchored on the literal `://` (the scheme is a lookbehind) so that even a direct
  // use of the exported pattern does not rescan long scheme-like runs from every start.
  scanRule(
    /:\/\/(?<=[a-z][a-z0-9+.-]*:\/\/)[^:/\s@]*:[^@\s]+@/gi,
    /:\/\//g,
    urlCredentialCompleter,
  ),
  regexRule(/((?:__Host-)?orc_sid=)[^;\s]+/g, prefixed),
];

/** Patterns applied by {@link maskText}; each is global (`String.prototype.replace` resets `lastIndex`). */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze(
  MASK_RULES.map((rule) => rule.pattern),
);

function applyMatches(text: string, matches: readonly MaskMatch[]): string {
  if (matches.length === 0) return text;
  const parts: string[] = [];
  let pos = 0;
  for (const m of matches) {
    parts.push(text.slice(pos, m.start), m.replacement);
    pos = m.end;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

export interface SecretRegistry {
  add(value: string | undefined | null): void;
  values(): readonly string[];
}

const MIN_SECRET_LENGTH = 8;

/** Registry of runtime secret values (DB/Redis passwords, API keys); values < 8 chars are ignored. */
export function createSecretRegistry(): SecretRegistry {
  const set = new Set<string>();
  let sorted: readonly string[] = [];
  const addVariant = (v: string): void => {
    if (v.length >= MIN_SECRET_LENGTH) set.add(v);
  };
  return {
    add(value) {
      if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
      const before = set.size;
      addVariant(value);
      addVariant(value.trim());
      // Percent-encoded form, as it appears inside URLs and connection strings.
      addVariant(encodeURIComponent(value));
      if (set.size !== before) {
        // Longest first, so a secret that contains another is replaced as a whole.
        sorted = Object.freeze([...set].sort((a, b) => b.length - a.length));
      }
    },
    values() {
      return sorted;
    },
  };
}

/**
 * Replaces registered secret values and {@link SECRET_VALUE_PATTERNS} matches with `[REDACTED]`.
 * Linear in the input length (no rule rescans the text from every candidate start).
 */
export function maskText(text: string, registry?: SecretRegistry): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  if (registry) {
    for (const value of registry.values()) {
      if (out.includes(value)) out = out.split(value).join(REDACTED);
    }
  }
  for (const rule of MASK_RULES) {
    out = applyMatches(out, rule.find(out));
  }
  return out;
}

const MAX_DEPTH = 32;

function maskValue(
  value: unknown,
  registry: SecretRegistry | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return maskText(value, registry);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => maskValue(item, registry, seen, depth + 1));
    }
    if (value instanceof Map) {
      const out = new Map<unknown, unknown>();
      for (const [k, v] of value) {
        out.set(
          k,
          typeof k === 'string' && isRedactKey(k) && v != null
            ? REDACTED
            : maskValue(v, registry, seen, depth + 1),
        );
      }
      return out;
    }
    if (value instanceof Set) {
      return new Set([...value].map((item) => maskValue(item, registry, seen, depth + 1)));
    }
    const out: Record<string, unknown> = {};
    if (value instanceof Error) {
      out.name = value.name;
      out.message = maskText(value.message, registry);
      if (typeof value.stack === 'string') out.stack = maskText(value.stack, registry);
    }
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        isRedactKey(key) && item != null ? REDACTED : maskValue(item, registry, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deep clone with values under {@link REDACT_KEYS} (exact or suffix match, any depth) replaced by
 * `[REDACTED]` and every string passed through {@link maskText}. Class instances become plain
 * objects of their own enumerable properties; Errors keep name/message/stack (masked).
 */
export function maskObject<T>(value: T, registry?: SecretRegistry): T {
  return maskValue(value, registry, new WeakSet<object>(), 0) as T;
}

// ---- chunk-safe masking for streamed output (stderr, test output) -------------------------------

export interface StreamMasker {
  /** Appends a chunk and returns the masked text that is safe to emit now (possibly ''). */
  push(chunk: string): string;
  /** Returns the masked remainder (end of stream, or a forced flush of a stale partial line). */
  flush(): string;
  /** Characters currently held back. */
  readonly pendingChars: number;
}

/** BEGIN/END markers for the hold decision; the label is bounded so a marker is at most ~230 chars. */
const PEM_MARKER = /-----(BEGIN|END) [A-Z ]{0,200}PRIVATE KEY-----/g;
/** Characters of held text rescanned with each chunk, so markers split across chunks are seen. */
const PEM_MARKER_BACKOFF = 256;
const DEFAULT_MAX_HOLD_CHARS = 65_536;
const MIN_OVERLAP_CHARS = 1024;

/** Largest position <= cut that lies strictly inside no secret/pattern match found in `text`. */
function safeCut(text: string, cut: number, registry: SecretRegistry | undefined): number {
  const spans: [number, number][] = [];
  for (const value of registry?.values() ?? []) {
    for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) {
      spans.push([i, i + value.length]);
    }
  }
  for (const rule of MASK_RULES) {
    for (const m of rule.find(text)) spans.push([m.start, m.end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  // Merge into disjoint open intervals; a point is unsafe iff it lies strictly inside one of them.
  let start = -1;
  let end = -1;
  for (const [s, e] of spans) {
    if (s < end) {
      if (e > end) end = e;
      continue;
    }
    if (start < cut && cut < end) return start;
    start = s;
    end = e;
  }
  return start < cut && cut < end ? start : cut;
}

/**
 * Masks a byte stream that arrives in arbitrary chunks (§13.1, §17.2). Text is released up to the
 * last line terminator (`\n` or `\r`), never inside an unterminated private-key block; the partial
 * line is held. A held tail longer than `maxHoldChars` is released except for an overlap window as
 * long as the longest registered secret (>= 1024 chars), and the cut never splits a detectable match,
 * so a secret split across chunk boundaries is always masked as a whole.
 *
 * Linear in the total stream length: each chunk is scanned once for line terminators and key
 * markers, the full-buffer match search runs only when the held tail exceeds the bound (and, while
 * a single match spans the whole buffer, again only after the buffer has grown geometrically).
 */
export function createStreamMasker(
  registry?: SecretRegistry,
  opts: { maxHoldChars?: number } = {},
): StreamMasker {
  const configuredHold = Math.max(
    opts.maxHoldChars ?? DEFAULT_MAX_HOLD_CHARS,
    MIN_OVERLAP_CHARS * 2,
  );
  // Held text as a list of chunks: concatenating into one string and scanning it on every push would
  // make V8 flatten (copy) the whole held buffer per chunk, i.e. O(held) per push.
  let parts: string[] = [];
  let length = 0;
  /** Last <= PEM_MARKER_BACKOFF chars of the held text, for markers split across chunks. */
  let tail = '';
  /** Index just after the last line terminator in the held text (0 if none). */
  let lineEnd = 0;
  /** Start of the last BEGIN marker in the held text without a later END marker, or -1. */
  let pemOpen = -1;
  /**
   * Closed key blocks (BEGIN..END) that are still held, in order. A block whose END marker arrives
   * before the newline that ends its line must not be released up to that earlier line end.
   */
  let blocks: { start: number; end: number }[] = [];
  /** Held length at which the next forced cut may be attempted after one that made no progress. */
  let retryAt = 0;
  const marker = new RegExp(PEM_MARKER.source, PEM_MARKER.flags);

  const overlap = (): number => {
    let longest = MIN_OVERLAP_CHARS;
    for (const v of registry?.values() ?? []) if (v.length > longest) longest = v.length;
    return longest;
  };

  const text = (): string => {
    if (parts.length > 1) parts = [parts.join('')];
    return parts[0] ?? '';
  };

  const append = (chunk: string): void => {
    const previousLength = length;
    parts.push(chunk);
    length += chunk.length;
    const terminator = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf('\r'));
    if (terminator >= 0) lineEnd = previousLength + terminator + 1;
    const window = tail + chunk;
    const offset = previousLength - tail.length;
    marker.lastIndex = 0;
    for (let m = marker.exec(window); m !== null; m = marker.exec(window)) {
      // Markers that ended inside the previously held text were handled by an earlier push.
      if (m.index + m[0].length <= tail.length) continue;
      if (m[1] === 'BEGIN') {
        pemOpen = offset + m.index;
      } else {
        if (pemOpen >= 0) blocks.push({ start: pemOpen, end: offset + m.index + m[0].length });
        pemOpen = -1;
      }
    }
    tail = window.length > PEM_MARKER_BACKOFF ? window.slice(-PEM_MARKER_BACKOFF) : window;
  };

  const release = (cut: number): string => {
    const all = text();
    const out = maskText(all.slice(0, cut), registry);
    const rest = all.slice(cut);
    parts = rest.length > 0 ? [rest] : [];
    length = rest.length;
    tail = rest.length > PEM_MARKER_BACKOFF ? rest.slice(-PEM_MARKER_BACKOFF) : rest;
    lineEnd = Math.max(0, lineEnd - cut);
    pemOpen = pemOpen >= cut ? pemOpen - cut : -1;
    blocks = blocks
      .filter((b) => b.end > cut)
      .map((b) => ({ start: Math.max(0, b.start - cut), end: b.end - cut }));
    retryAt = 0;
    return out;
  };

  return {
    push(chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return '';
      append(chunk);
      let cut = lineEnd;
      if (pemOpen >= 0 && pemOpen < cut) cut = pemOpen;
      for (let i = blocks.length - 1; i >= 0 && cut > 0; i -= 1) {
        const block = blocks[i];
        if (block === undefined || block.end <= cut) break;
        if (block.start < cut) cut = block.start;
      }
      const window = overlap();
      const maxHold = Math.max(configuredHold, window * 2);
      if (length - cut > maxHold && length >= retryAt) {
        const forced = safeCut(text(), Math.max(cut, length - window), registry);
        // No progress means one match covers the whole tail: retry only after the held text grew by
        // half again, so a giant match costs O(n) in total instead of O(held) per chunk.
        const stalled = forced <= cut;
        cut = forced;
        const out = cut > 0 ? release(cut) : '';
        if (stalled) retryAt = length + Math.max(maxHold >> 1, length >> 1);
        return out;
      }
      return cut > 0 ? release(cut) : '';
    },
    flush() {
      const out = maskText(text(), registry);
      parts = [];
      length = 0;
      tail = '';
      lineEnd = 0;
      pemOpen = -1;
      blocks = [];
      retryAt = 0;
      return out;
    },
    get pendingChars() {
      return length;
    },
  };
}
