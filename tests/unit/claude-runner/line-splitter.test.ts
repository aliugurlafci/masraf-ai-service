import { describe, expect, it } from 'vitest';
import { LineSplitter } from '@orc/claude-runner';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('LineSplitter (§10.5)', () => {
  it('splits on \\n across chunks and strips a trailing \\r', () => {
    const s = new LineSplitter(1024);
    expect(s.push(b('{"a":'))).toEqual([]);
    expect(s.push(b('1}\r\n{"b"'))).toEqual([{ text: '{"a":1}', truncated: false }]);
    expect(s.push(b(':2}\n\n'))).toEqual([
      { text: '{"b":2}', truncated: false },
      { text: '', truncated: false },
    ]);
    expect(s.flush()).toEqual([]);
  });

  it('emits an unterminated last line on flush', () => {
    const s = new LineSplitter(1024);
    s.push(b('tail'));
    expect(s.pendingBytes).toBe(4);
    expect(s.flush()).toEqual([{ text: 'tail', truncated: false }]);
    expect(s.flush()).toEqual([]);
  });

  it('never splits a multi-byte character between chunks', () => {
    const s = new LineSplitter(1024);
    const bytes = b('çğü\n');
    const out = [...s.push(bytes.subarray(0, 1)), ...s.push(bytes.subarray(1, 3)), ...s.push(bytes.subarray(3))];
    expect(out).toEqual([{ text: 'çğü', truncated: false }]);
  });

  it('cuts lines over the byte limit and discards the rest of that line', () => {
    const s = new LineSplitter(8);
    expect(s.push(b('0123456789abc'))).toEqual([{ text: '01234567', truncated: true }]);
    expect(s.push(b('defgh\nok\n'))).toEqual([{ text: 'ok', truncated: false }]);
    expect(s.push(b('x'.repeat(20)))).toEqual([{ text: 'xxxxxxxx', truncated: true }]);
    expect(s.flush()).toEqual([]);
    expect(s.push(b('exactly8\n'))).toEqual([{ text: 'exactly8', truncated: false }]);
  });

  it('drops an incomplete UTF-8 sequence at a cut', () => {
    const s = new LineSplitter(4);
    const [line] = s.push(b('abcğdef\n'));
    expect(line).toEqual({ text: 'abc', truncated: true });
  });
});
