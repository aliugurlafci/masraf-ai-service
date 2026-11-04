// Minimal YAML reader for the static deployment checks (tests/security). Supports the subset the
// repository's compose files use: block maps and sequences, flow sequences/maps (also spanning lines),
// single/double-quoted and plain scalars, literal/folded block scalars, comments, anchors, aliases and
// merge keys (`<<: *a` / `<<: [*a, *b]`). Anything else throws, so an unsupported construct can never
// be silently misread into a passing security check. Only `yaml` exists as a transitive package, and
// tests must not depend on undeclared packages (contract §1.2).

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlLiteError extends Error {
  constructor(message: string, line: number) {
    super(`yaml-lite: ${message} (line ${line + 1})`);
    this.name = 'YamlLiteError';
  }
}

export function isYamlMap(v: YamlValue | undefined): v is YamlMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const MERGE_KEY = '<<';

/** Strips a trailing comment (`#` at line start or after whitespace, outside quotes). */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i += 1;
        else quote = null;
      } else if (c === '\\' && quote === '"') {
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:-]/.test(s[i - 1] ?? '')) quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1] ?? ''))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function indentOf(raw: string): number {
  const m = /^( *)/.exec(raw);
  if (raw.startsWith('\t') || /^ *\t/.test(raw)) throw new YamlLiteError('tab indentation', 0);
  return m?.[1]?.length ?? 0;
}

/** Index of the `:` that separates a mapping key from its value, or -1. */
function keySeparator(s: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    if (c === ']' || c === '}') depth -= 1;
    if (c === ':' && depth === 0 && (i === s.length - 1 || s[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquote(s: string, line: number): string {
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlLiteError(`unterminated quote: ${s}`, line);
    return s.slice(1, -1).replaceAll("''", "'");
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlLiteError(`unterminated quote: ${s}`, line);
    return s
      .slice(1, -1)
      .replace(/\\(["\\/nrt0])/g, (_m, ch: string) =>
        ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch === '0' ? '\0' : ch,
      );
  }
  return s;
}

function plainScalar(s: string): YamlValue {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function bracketBalance(s: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (const c of s) {
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
  }
  return depth;
}

class Parser {
  private pos = 0;
  private readonly anchors = new Map<string, YamlValue>();

  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  parseDocument(): YamlValue {
    this.skipBlank();
    if (this.pos >= this.lines.length) return null;
    const indent = indentOf(this.lines[this.pos] ?? '');
    const value = this.parseBlock(indent);
    this.skipBlank();
    if (this.pos < this.lines.length) {
      throw new YamlLiteError('unexpected content after document', this.pos);
    }
    return value;
  }

  private skipBlank(): void {
    while (this.pos < this.lines.length) {
      const t = stripComment((this.lines[this.pos] ?? '').trim());
      if (t === '' || t === '---') this.pos += 1;
      else break;
    }
  }

  private current(): { indent: number; text: string } | null {
    this.skipBlank();
    if (this.pos >= this.lines.length) return null;
    const raw = this.lines[this.pos] ?? '';
    return { indent: indentOf(raw), text: stripComment(raw.trim()) };
  }

  private parseBlock(indent: number): YamlValue {
    const cur = this.current();
    if (cur === null) return null;
    if (cur.text === '-' || cur.text.startsWith('- ')) return this.parseSeq(indent);
    return this.parseMap(indent);
  }

  private parseMap(indent: number): YamlMap {
    const explicit: YamlMap = {};
    const merged: YamlMap[] = [];
    for (;;) {
      const cur = this.current();
      if (cur === null || cur.indent < indent) break;
      if (cur.indent > indent) throw new YamlLiteError('unexpected indentation', this.pos);
      if (cur.text === '-' || cur.text.startsWith('- ')) break;
      const sep = keySeparator(cur.text);
      if (sep < 0) throw new YamlLiteError(`expected "key: value": ${cur.text}`, this.pos);
      const key = unquote(cur.text.slice(0, sep).trim(), this.pos);
      const rest = cur.text.slice(sep + 1).trim();
      const lineNo = this.pos;
      this.pos += 1;
      const value = this.parseValue(rest, indent, lineNo);
      if (key === MERGE_KEY) {
        const sources = Array.isArray(value) ? value : [value];
        for (const s of sources) {
          if (!isYamlMap(s)) throw new YamlLiteError('merge key needs a map or list of maps', lineNo);
          merged.push(s);
        }
        continue;
      }
      if (Object.hasOwn(explicit, key)) throw new YamlLiteError(`duplicate key ${key}`, lineNo);
      explicit[key] = value;
    }
    // Explicit keys win over merged ones; earlier merge sources win over later ones.
    const out: YamlMap = {};
    for (const source of [...merged].reverse()) Object.assign(out, structuredClone(source));
    return Object.assign(out, explicit);
  }

  private parseSeq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const cur = this.current();
      if (cur === null || cur.indent < indent) break;
      if (cur.indent > indent) throw new YamlLiteError('unexpected indentation in sequence', this.pos);
      if (!(cur.text === '-' || cur.text.startsWith('- '))) break;
      const rest = cur.text.slice(1).trim();
      const lineNo = this.pos;
      if (rest !== '' && keySeparator(rest) >= 0 && !/^['"[{&*|>]/.test(rest)) {
        // "- key: value" starts a map indented by the dash.
        const raw = this.lines[this.pos] ?? '';
        const dash = raw.indexOf('-');
        this.lines[this.pos] = `${' '.repeat(dash + 1)}${raw.slice(dash + 1)}`;
        const inner = indentOf(this.lines[this.pos] ?? '');
        out.push(this.parseMap(inner));
        continue;
      }
      this.pos += 1;
      out.push(this.parseValue(rest, indent, lineNo));
    }
    return out;
  }

  /** Value after `key:` or `- ` on line `lineNo` (already consumed) of a node at `indent`. */
  private parseValue(rest: string, indent: number, lineNo: number): YamlValue {
    let text = rest;
    let anchor: string | null = null;
    const anchorMatch = /^&([A-Za-z0-9_-]+)(?:\s+|$)/.exec(text);
    if (anchorMatch) {
      anchor = anchorMatch[1] ?? null;
      text = text.slice(anchorMatch[0].length);
    }
    // Compose merge tags: `!override` replaces instead of merging (the value is what we check);
    // `!reset` drops the value. Any other tag is unsupported.
    let reset = false;
    const tagMatch = /^!(\S*)(?:\s+|$)/.exec(text);
    if (tagMatch) {
      if (tagMatch[1] !== 'override' && tagMatch[1] !== 'reset') {
        throw new YamlLiteError(`unsupported tag !${tagMatch[1] ?? ''}`, lineNo);
      }
      reset = tagMatch[1] === 'reset';
      text = text.slice(tagMatch[0].length);
    }
    let value: YamlValue;
    const following = text === '' ? this.current() : null;
    if (following !== null && following.indent > indent && /^[[{]/.test(following.text)) {
      // Flow collection that starts on the next line (`key:\n  [a,\n   b]`).
      text = following.text;
      this.pos += 1;
    }
    if (text === '') {
      const next = this.current();
      if (next !== null && next.indent > indent) value = this.parseBlock(next.indent);
      else if (next !== null && next.indent === indent && (next.text === '-' || next.text.startsWith('- ')))
        value = this.parseSeq(indent);
      else value = null;
    } else if (/^[|>][+-]?$/.test(text)) {
      value = this.blockScalar(text, indent);
    } else {
      while (bracketBalance(text) > 0) {
        if (this.pos >= this.lines.length) throw new YamlLiteError('unterminated flow collection', lineNo);
        text = `${text} ${stripComment((this.lines[this.pos] ?? '').trim())}`;
        this.pos += 1;
      }
      value = this.inline(text, lineNo);
    }
    if (reset) value = null;
    if (anchor !== null) this.anchors.set(anchor, value);
    return value;
  }

  private blockScalar(header: string, indent: number): string {
    const folded = header.startsWith('>');
    const chomp = header.length > 1 ? header[1] : '';
    const body: string[] = [];
    let blockIndent = -1;
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? '';
      if (raw.trim() === '') {
        body.push('');
        this.pos += 1;
        continue;
      }
      const ind = indentOf(raw);
      if (ind <= indent) break;
      if (blockIndent < 0) blockIndent = ind;
      if (ind < blockIndent) break;
      body.push(raw.slice(blockIndent));
      this.pos += 1;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const joined = folded ? body.join(' ') : body.join('\n');
    return chomp === '-' ? joined : `${joined}\n`;
  }

  private inline(text: string, lineNo: number): YamlValue {
    const t = text.trim();
    if (t.startsWith('*')) {
      const name = t.slice(1);
      if (!this.anchors.has(name)) throw new YamlLiteError(`unknown alias *${name}`, lineNo);
      return structuredClone(this.anchors.get(name) ?? null);
    }
    if (t.startsWith('[') || t.startsWith('{')) {
      const [value, end] = this.flow(t, 0, lineNo);
      if (t.slice(end).trim() !== '') throw new YamlLiteError(`trailing text after flow: ${t}`, lineNo);
      return value;
    }
    if (t.startsWith("'") || t.startsWith('"')) return unquote(t, lineNo);
    return plainScalar(t);
  }

  /** Parses a flow collection or scalar starting at `i`; returns [value, index after it]. */
  private flow(s: string, start: number, lineNo: number): [YamlValue, number] {
    let i = start;
    while (s[i] === ' ') i += 1;
    const c = s[i];
    if (c === '[') {
      const out: YamlValue[] = [];
      i += 1;
      for (;;) {
        while (s[i] === ' ') i += 1;
        if (s[i] === ']') return [out, i + 1];
        const [item, next] = this.flow(s, i, lineNo);
        out.push(item);
        i = next;
        while (s[i] === ' ') i += 1;
        if (s[i] === ',') i += 1;
        else if (s[i] !== ']') throw new YamlLiteError(`bad flow sequence: ${s}`, lineNo);
      }
    }
    if (c === '{') {
      const out: YamlMap = {};
      i += 1;
      for (;;) {
        while (s[i] === ' ') i += 1;
        if (s[i] === '}') return [out, i + 1];
        const [k, afterKey] = this.flowScalar(s, i, lineNo, true);
        i = afterKey;
        while (s[i] === ' ') i += 1;
        if (s[i] !== ':') throw new YamlLiteError(`bad flow map: ${s}`, lineNo);
        const [v, next] = this.flow(s, i + 1, lineNo);
        if (typeof k === 'object' && k !== null) throw new YamlLiteError(`bad flow map key: ${s}`, lineNo);
        out[String(k)] = v;
        i = next;
        while (s[i] === ' ') i += 1;
        if (s[i] === ',') i += 1;
        else if (s[i] !== '}') throw new YamlLiteError(`bad flow map: ${s}`, lineNo);
      }
    }
    return this.flowScalar(s, i, lineNo, false);
  }

  private flowScalar(s: string, start: number, lineNo: number, isKey: boolean): [YamlValue, number] {
    let i = start;
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < s.length; j += 1) {
        if (s[j] === c) {
          if (c === "'" && s[j + 1] === "'") {
            j += 1;
            continue;
          }
          break;
        }
        if (c === '"' && s[j] === '\\') j += 1;
      }
      if (j >= s.length) throw new YamlLiteError(`unterminated quote in flow: ${s}`, lineNo);
      return [unquote(s.slice(i, j + 1), lineNo), j + 1];
    }
    const stop = isKey ? /[,:\]}]/ : /[,\]}]/;
    while (i < s.length && !stop.test(s[i] ?? '')) i += 1;
    const token = s.slice(start, i).trim();
    if (token.startsWith('*')) return [this.inline(token, lineNo), i];
    return [plainScalar(token), i];
  }
}

export function parseYaml(text: string): YamlValue {
  return new Parser(text.split(/\r?\n/)).parseDocument();
}
