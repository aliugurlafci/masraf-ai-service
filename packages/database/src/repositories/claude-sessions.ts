// ClaudeSessions (contract §2.5, T-M5: start() is an upsert on AttemptId).
import { maskText } from '@orc/security';
import { T, first, run, truncateUtf8 } from '../sql.js';
import type { RepoContext } from '../sql.js';
import type { ClaudeSessionRepository } from '../types.js';
import { mapClaudeSession } from './mappers.js';

/** PermissionDenialsJson and ResultText are capped at 64 KiB (UTF-8). */
export const CLAUDE_TEXT_CAP_BYTES = 65_536;

const SESSION_START = `MERGE orc.ClaudeSessions WITH (HOLDLOCK) AS target
USING (SELECT @attemptId AS AttemptId) AS src
ON target.AttemptId = src.AttemptId
WHEN MATCHED THEN UPDATE SET
  Status = 'starting', SessionId = @sessionId, ResumedFromSessionId = @resumedFromSessionId, Model = @model,
  CliVersion = @cliVersion, PermissionMode = @permissionMode,
  ToolsJson = NULL, McpServersJson = NULL, ApiKeySource = NULL, ResultSubtype = NULL, IsError = NULL,
  StopReason = NULL, TerminalReason = NULL, NumTurns = NULL, TotalCostUsd = NULL, InputTokens = NULL,
  OutputTokens = NULL, CacheCreationInputTokens = NULL, CacheReadInputTokens = NULL, DurationMs = NULL,
  DurationApiMs = NULL, PermissionDenialsCount = NULL, PermissionDenialsJson = NULL, ResultText = NULL,
  InitAt = NULL, EndedAt = NULL, StartedAt = SYSUTCDATETIME(), RunCount = target.RunCount + 1,
  UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
  (AttemptId, TaskId, SessionId, ResumedFromSessionId, Status, Model, CliVersion, PermissionMode)
  VALUES (@attemptId, @taskId, @sessionId, @resumedFromSessionId, 'starting', @model, @cliVersion, @permissionMode);`;

const SESSION_INIT = `UPDATE orc.ClaudeSessions SET
  Status = 'running', SessionId = @sessionId, Model = @model, ToolsJson = @tools, McpServersJson = @mcpServers,
  ApiKeySource = @apiKeySource, CliVersion = COALESCE(@cliVersion, CliVersion), InitAt = SYSUTCDATETIME(),
  UpdatedAt = SYSUTCDATETIME()
WHERE AttemptId = @attemptId;`;

const SESSION_RESULT = `UPDATE orc.ClaudeSessions SET
  Status = @status, ResultSubtype = @resultSubtype, IsError = @isError, StopReason = @stopReason,
  TerminalReason = @terminalReason, NumTurns = @numTurns, TotalCostUsd = @totalCostUsd,
  InputTokens = @inputTokens, OutputTokens = @outputTokens, CacheCreationInputTokens = @cacheCreationInputTokens,
  CacheReadInputTokens = @cacheReadInputTokens, DurationMs = @durationMs, DurationApiMs = @durationApiMs,
  PermissionDenialsCount = @permissionDenialsCount, PermissionDenialsJson = @permissionDenials,
  ResultText = @resultText, EndedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
WHERE AttemptId = @attemptId;`;

const SESSION_BY_ATTEMPT = 'SELECT * FROM orc.ClaudeSessions WHERE AttemptId = @attemptId;';
const SESSION_LATEST_WITH_ID = `SELECT TOP (1) * FROM orc.ClaudeSessions
WHERE TaskId = @taskId AND SessionId IS NOT NULL
ORDER BY StartedAt DESC, CreatedAt DESC;`;

/** Serializes the denial list, dropping trailing entries until it fits the cap. */
function cappedDenials(denials: readonly unknown[] | null): string | null {
  if (denials === null) return null;
  let count = denials.length;
  let text = JSON.stringify(denials);
  while (Buffer.byteLength(text, 'utf8') > CLAUDE_TEXT_CAP_BYTES && count > 0) {
    count = Math.floor(count / 2);
    text = JSON.stringify(denials.slice(0, count));
  }
  return text;
}

export function createClaudeSessionRepository(ctx: RepoContext): ClaudeSessionRepository {
  return {
    async start(s) {
      await run(ctx, SESSION_START, [
        ['attemptId', T.guid, s.attemptId],
        ['taskId', T.guid, s.taskId],
        ['sessionId', T.varchar(64), s.sessionId],
        ['resumedFromSessionId', T.varchar(64), s.resumedFromSessionId],
        ['model', T.nvarchar(100), s.model],
        ['cliVersion', T.varchar(32), s.cliVersion],
        ['permissionMode', T.varchar(24), s.permissionMode],
      ]);
    },
    async recordInit(attemptId, i) {
      await run(ctx, SESSION_INIT, [
        ['attemptId', T.guid, attemptId],
        ['sessionId', T.varchar(64), i.sessionId],
        ['model', T.nvarchar(100), i.model],
        ['tools', T.nvarcharMax, JSON.stringify(i.tools)],
        ['mcpServers', T.nvarcharMax, JSON.stringify(i.mcpServers)],
        ['apiKeySource', T.varchar(64), i.apiKeySource],
        ['cliVersion', T.varchar(32), i.cliVersion],
      ]);
    },
    async recordResult(attemptId, r) {
      const resultText =
        r.resultText === null ? null : truncateUtf8(maskText(r.resultText, ctx.secrets), CLAUDE_TEXT_CAP_BYTES);
      await run(ctx, SESSION_RESULT, [
        ['attemptId', T.guid, attemptId],
        ['status', T.varchar(10), r.status],
        ['resultSubtype', T.varchar(64), r.resultSubtype],
        ['isError', T.bit, r.isError],
        ['stopReason', T.varchar(64), r.stopReason],
        ['terminalReason', T.varchar(64), r.terminalReason],
        ['numTurns', T.int, r.numTurns],
        ['totalCostUsd', T.cost, r.totalCostUsd],
        ['inputTokens', T.bigint, r.inputTokens],
        ['outputTokens', T.bigint, r.outputTokens],
        ['cacheCreationInputTokens', T.bigint, r.cacheCreationInputTokens],
        ['cacheReadInputTokens', T.bigint, r.cacheReadInputTokens],
        ['durationMs', T.bigint, r.durationMs],
        ['durationApiMs', T.bigint, r.durationApiMs],
        ['permissionDenialsCount', T.int, r.permissionDenialsCount],
        ['permissionDenials', T.nvarcharMax, cappedDenials(r.permissionDenials)],
        ['resultText', T.nvarcharMax, resultText],
      ]);
    },
    async findByAttempt(attemptId) {
      const row = first((await run(ctx, SESSION_BY_ATTEMPT, [['attemptId', T.guid, attemptId]])).rows);
      return row ? mapClaudeSession(row) : null;
    },
    async findLatestWithSessionId(taskId) {
      const row = first((await run(ctx, SESSION_LATEST_WITH_ID, [['taskId', T.guid, taskId]])).rows);
      return row ? mapClaudeSession(row) : null;
    },
  };
}
