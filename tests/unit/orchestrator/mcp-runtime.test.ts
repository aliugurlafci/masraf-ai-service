import { describe, expect, it } from 'vitest';
import { PathEscapeError } from '@orc/security';
import { mcpRuntimeDecision } from '../../../packages/orchestrator/src/mcp-runtime';

const escape = () => new PathEscapeError('runtime dir has mode 0755');
const io = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

describe('mcpRuntimeDecision (ADR-0037)', () => {
  it.each([
    ['MCP_REQUIRED', { mcpRequired: true, requireIndex: false }],
    ['requireIndex (K9 9.1)', { mcpRequired: false, requireIndex: true }],
    ['both', { mcpRequired: true, requireIndex: true }],
  ])('fail-closed when %s: path_escape => security_violation', (_n, opts) => {
    const d = mcpRuntimeDecision(escape(), opts);
    expect(d).toEqual({ settle: ['failed', 'security_violation', 'runtime dir has mode 0755'] });
  });

  it.each([
    ['MCP_REQUIRED', { mcpRequired: true, requireIndex: false }],
    ['requireIndex', { mcpRequired: false, requireIndex: true }],
  ])('fail-closed when %s: other errors => workspace_error', (_n, opts) => {
    expect(mcpRuntimeDecision(io(), opts)).toEqual({
      settle: ['failed', 'workspace_error', 'EACCES: permission denied'],
    });
    expect(mcpRuntimeDecision('boom', opts)).toEqual({ settle: ['failed', 'workspace_error', 'boom'] });
  });

  it('warns (Claude starts without MCP) when neither flag is set, with the error code', () => {
    const opts = { mcpRequired: false, requireIndex: false };
    expect(mcpRuntimeDecision(escape(), opts)).toEqual({
      warn: { warning: 'mcp_runtime_rejected', errorCode: 'path_escape', message: 'runtime dir has mode 0755' },
    });
    expect(mcpRuntimeDecision(io(), opts)).toMatchObject({ warn: { errorCode: 'EACCES' } });
  });
});
