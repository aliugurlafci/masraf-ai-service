import { describe, expect, it } from 'vitest';
import {
  ClaudeEventPayloadSchema,
  parseClaudeLine,
  summarizeClaudeLine,
  type ParsedClaudeLine,
} from '@orc/shared';

const ctx = {
  taskId: '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e',
  attemptId: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
  line: 7,
  at: '2026-11-02T10:00:00.000Z',
};

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 's-1',
  cwd: '/w',
  tools: ['Read', 'Edit'],
  mcp_servers: [{ name: 'codebase-memory-mcp', status: 'connected', source: 'cli' }],
  model: 'claude-x',
  permissionMode: 'dontAsk',
  claude_code_version: '2.1.316',
  future_field: { nested: true },
};

function summarize(p: ParsedClaudeLine) {
  const events = summarizeClaudeLine(p, ctx);
  for (const e of events) expect(ClaudeEventPayloadSchema.safeParse(e).success).toBe(true);
  return events;
}

describe('parseClaudeLine', () => {
  it('parses init and preserves unknown fields', () => {
    const p = parseClaudeLine(JSON.stringify(init));
    expect(p.kind).toBe('init');
    if (p.kind !== 'init') return;
    expect(p.event.future_field).toEqual({ nested: true });
    expect(p.event.mcp_servers[0]?.name).toBe('codebase-memory-mcp');
  });

  it('strips a trailing CR', () => {
    expect(parseClaudeLine(`${JSON.stringify(init)}\r`).kind).toBe('init');
  });

  it('marks schema mismatches of known types as invalid', () => {
    const p = parseClaudeLine(JSON.stringify({ ...init, tools: 'Read' }));
    expect(p.kind).toBe('invalid');
    if (p.kind === 'invalid') expect(p.error).toContain('tools');
    expect(parseClaudeLine('{"type":"result","subtype":"success"}').kind).toBe('invalid');
    expect(parseClaudeLine('{"type":"assistant","message":{}}').kind).toBe('invalid');
  });

  it.each(['', '   ', 'not json', '[1,2]', '42', 'null', '"str"', '{"no_type":1}', '{"type":5}'])(
    'never throws and returns invalid for %j',
    (raw) => {
      const p = parseClaudeLine(raw);
      expect(p.kind).toBe('invalid');
      if (p.kind === 'invalid') expect(p.raw).toBe(raw);
    },
  );

  it('classifies hook, system, rate limit and unknown types', () => {
    expect(parseClaudeLine('{"type":"system","subtype":"hook_started","hook":"x"}')).toMatchObject({
      kind: 'hook',
      subtype: 'hook_started',
    });
    expect(parseClaudeLine('{"type":"system","subtype":"compact_boundary"}')).toMatchObject({
      kind: 'system',
      subtype: 'compact_boundary',
    });
    expect(parseClaudeLine('{"type":"system"}')).toMatchObject({ kind: 'system', subtype: null });
    expect(parseClaudeLine('{"type":"rate_limit_event","limit":1}').kind).toBe('rate_limit');
    expect(parseClaudeLine('{"type":"stream_event","x":1}').kind).toBe('unknown');
  });
});

describe('summarizeClaudeLine', () => {
  it('emits one event per assistant content block', () => {
    const p = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/w/a.ts' } },
            { type: 'server_tool_use', id: 'x' },
          ],
        },
      }),
    );
    const events = summarize(p);
    expect(events.map((e) => [e.block, e.kind])).toEqual([
      [0, 'thinking'],
      [1, 'assistant_text'],
      [2, 'tool_use'],
      [3, 'unknown'],
    ]);
    expect(events[1]?.text).toBe('hello');
    expect(events[2]).toMatchObject({
      toolName: 'Read',
      toolUseId: 'tu_1',
      text: '{"file_path":"/w/a.ts"}',
    });
    expect(
      events.every((e) => e.taskId === ctx.taskId && e.line === 7 && e.at === ctx.at && e.v === 1),
    ).toBe(true);
  });

  it('truncates long text to 2000 chars and tool input to 2000 chars', () => {
    const long = 'x'.repeat(20_000);
    const [text, tool] = summarize(
      parseClaudeLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: long },
              { type: 'tool_use', id: 't', name: 'Write', input: { c: long } },
            ],
          },
        }),
      ),
    );
    expect(text?.text).toHaveLength(2000);
    expect(text?.text?.endsWith('...[truncated]')).toBe(true);
    expect(tool?.text?.length).toBeLessThanOrEqual(2000);
    expect(tool?.text?.endsWith('...[truncated]')).toBe(true);
  });

  it('never splits a surrogate pair when truncating', () => {
    const [e] = summarize(
      parseClaudeLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '\u{1F600}'.repeat(5000) }] },
        }),
      ),
    );
    const text = e?.text ?? '';
    const beforeSuffix = text.slice(0, text.length - '...[truncated]'.length);
    const last = beforeSuffix.charCodeAt(beforeSuffix.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('maps tool results with error flag and array content', () => {
    const [e] = summarize(
      parseClaudeLine(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                is_error: true,
                content: [{ type: 'text', text: 'boom' }],
              },
            ],
          },
        }),
      ),
    );
    expect(e).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_1',
      isError: true,
      text: 'boom',
    });
  });

  it('summarizes result, init, system, rate limit, unknown and invalid lines', () => {
    const [result] = summarize(
      parseClaudeLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 3,
          result: 'done',
          total_cost_usd: 0.12,
          duration_ms: 1000,
        }),
      ),
    );
    expect(result).toMatchObject({
      kind: 'result',
      text: 'done',
      isError: false,
      data: {
        subtype: 'success',
        isError: false,
        numTurns: 3,
        totalCostUsd: 0.12,
        durationMs: 1000,
      },
    });

    const [initEvent] = summarize(parseClaudeLine(JSON.stringify(init)));
    expect(initEvent).toMatchObject({
      kind: 'init',
      data: {
        model: 'claude-x',
        sessionId: 's-1',
        tools: 2,
        mcpServers: [{ name: 'codebase-memory-mcp', status: 'connected' }],
      },
    });

    expect(
      summarize(parseClaudeLine('{"type":"system","subtype":"hook_response"}'))[0],
    ).toMatchObject({ kind: 'system', text: 'hook_response' });

    const [rl] = summarize(
      parseClaudeLine('{"type":"rate_limit_event","info":{"status":"allowed"}}'),
    );
    expect(rl).toMatchObject({
      kind: 'rate_limit',
      data: { type: 'rate_limit_event', info: { status: 'allowed' } },
    });
    const [bigRl] = summarize(
      parseClaudeLine(JSON.stringify({ type: 'rate_limit_event', blob: 'x'.repeat(5000) })),
    );
    expect(JSON.stringify(bigRl?.data).length).toBeLessThanOrEqual(2048 + 64);

    expect(summarize(parseClaudeLine('{"type":"stream_event"}'))[0]).toMatchObject({
      kind: 'unknown',
      text: 'stream_event',
    });

    const [bad] = summarize(parseClaudeLine(`garbage ${'y'.repeat(5000)}`));
    expect(bad?.kind).toBe('invalid');
    expect(bad?.text?.length).toBeLessThanOrEqual(2000);
  });
});
