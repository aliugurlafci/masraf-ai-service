// Minimal unified-diff parser for rendering stored per-file patches with line numbers.

export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'delete' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number.parseInt(header[1] ?? '0', 10);
      newLine = Number.parseInt(header[2] ?? '0', 10);
      inHunk = true;
      out.push({ kind: 'hunk', oldNumber: null, newNumber: null, text: line });
      continue;
    }
    if (!inHunk) {
      out.push({ kind: 'meta', oldNumber: null, newNumber: null, text: line });
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      out.push({ kind: 'meta', oldNumber: null, newNumber: null, text: line });
      continue;
    }
    const marker = line.charAt(0);
    if (marker === '+') {
      out.push({ kind: 'add', oldNumber: null, newNumber: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (marker === '-') {
      out.push({ kind: 'delete', oldNumber: oldLine, newNumber: null, text: line.slice(1) });
      oldLine += 1;
    } else if (marker === '\\') {
      out.push({ kind: 'note', oldNumber: null, newNumber: null, text: line });
    } else {
      out.push({ kind: 'context', oldNumber: oldLine, newNumber: newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}
