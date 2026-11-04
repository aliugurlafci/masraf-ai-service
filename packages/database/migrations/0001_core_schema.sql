-- 0001_core_schema: normative DDL of contract section 4.1 (schema orc; created by the runner before this file).
-- Defaults are named DF_<Table>_<Column>. Batches are separated by GO lines.

CREATE TABLE orc.Users (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Users_Id DEFAULT NEWSEQUENTIALID(),
  Username NVARCHAR(64) NOT NULL,                       -- lower-case
  DisplayName NVARCHAR(128) NOT NULL,
  Email NVARCHAR(254) NULL,
  Role VARCHAR(16) NOT NULL,
  PasswordHash VARCHAR(255) NOT NULL,
  PasswordChangedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Users_PasswordChangedAt DEFAULT SYSUTCDATETIME(),
  IsActive BIT NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT 1,
  FailedLoginCount INT NOT NULL CONSTRAINT DF_Users_FailedLoginCount DEFAULT 0,
  LockedUntil DATETIME2(3) NULL,
  LastLoginAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Users_UpdatedAt DEFAULT SYSUTCDATETIME(),
  RowVer ROWVERSION NOT NULL,
  CONSTRAINT PK_Users PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_Users_Username UNIQUE (Username),
  CONSTRAINT CK_Users_Role CHECK (Role IN ('admin','operator','auditor')),
  CONSTRAINT CK_Users_Username CHECK (Username COLLATE Latin1_General_BIN2 = LOWER(Username) COLLATE Latin1_General_BIN2 AND LEN(Username) >= 3),
  CONSTRAINT CK_Users_FailedLoginCount CHECK (FailedLoginCount >= 0)
);
GO

CREATE TABLE orc.Teams (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Teams_Id DEFAULT NEWSEQUENTIALID(),
  Name NVARCHAR(100) NOT NULL,
  Description NVARCHAR(2000) NULL,
  ManagerAgentId UNIQUEIDENTIFIER NULL,                 -- FK added after Agents
  OwnedPathsJson NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Teams_OwnedPathsJson DEFAULT N'[]',
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Teams_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Teams_UpdatedAt DEFAULT SYSUTCDATETIME(),
  RowVer ROWVERSION NOT NULL,
  CONSTRAINT PK_Teams PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_Teams_Name UNIQUE (Name),
  CONSTRAINT CK_Teams_OwnedPathsJson CHECK (ISJSON(OwnedPathsJson, ARRAY) = 1)
);
GO

CREATE TABLE orc.Agents (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Agents_Id DEFAULT NEWSEQUENTIALID(),
  TeamId UNIQUEIDENTIFIER NOT NULL,
  ParentAgentId UNIQUEIDENTIFIER NULL,
  Name NVARCHAR(100) NOT NULL,
  Title NVARCHAR(100) NOT NULL,
  Description NVARCHAR(2000) NULL,
  IsManager BIT NOT NULL CONSTRAINT DF_Agents_IsManager DEFAULT 0,
  Model NVARCHAR(100) NOT NULL,
  Effort VARCHAR(8) NULL,
  AllowedToolsJson NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Agents_AllowedToolsJson DEFAULT N'[]',
  DisallowedToolsJson NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Agents_DisallowedToolsJson DEFAULT N'[]',
  Instructions NVARCHAR(4000) NULL,
  MaxTimeoutSeconds INT NOT NULL CONSTRAINT DF_Agents_MaxTimeoutSeconds DEFAULT 3600,
  MaxBudgetUsd DECIMAL(10,4) NULL,
  IsActive BIT NOT NULL CONSTRAINT DF_Agents_IsActive DEFAULT 1,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Agents_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Agents_UpdatedAt DEFAULT SYSUTCDATETIME(),
  RowVer ROWVERSION NOT NULL,
  CONSTRAINT PK_Agents PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_Agents_Name UNIQUE (Name),
  CONSTRAINT FK_Agents_Teams FOREIGN KEY (TeamId) REFERENCES orc.Teams (Id),
  CONSTRAINT FK_Agents_ParentAgent FOREIGN KEY (ParentAgentId) REFERENCES orc.Agents (Id),
  CONSTRAINT CK_Agents_Effort CHECK (Effort IS NULL OR Effort IN ('low','medium','high')),
  CONSTRAINT CK_Agents_AllowedToolsJson CHECK (ISJSON(AllowedToolsJson, ARRAY) = 1),
  CONSTRAINT CK_Agents_DisallowedToolsJson CHECK (ISJSON(DisallowedToolsJson, ARRAY) = 1),
  CONSTRAINT CK_Agents_MaxTimeoutSeconds CHECK (MaxTimeoutSeconds BETWEEN 60 AND 86400),
  CONSTRAINT CK_Agents_MaxBudgetUsd CHECK (MaxBudgetUsd IS NULL OR MaxBudgetUsd > 0)
);
CREATE INDEX IX_Agents_TeamId ON orc.Agents (TeamId);
ALTER TABLE orc.Teams ADD CONSTRAINT FK_Teams_ManagerAgent FOREIGN KEY (ManagerAgentId) REFERENCES orc.Agents (Id);
GO

CREATE TABLE orc.Projects (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Projects_Id DEFAULT NEWSEQUENTIALID(),
  Name NVARCHAR(100) NOT NULL,
  Description NVARCHAR(2000) NULL,
  RepoPath NVARCHAR(255) NOT NULL,                      -- relative to PROJECTS_ROOT, '/' separated, immutable
  DefaultBranch NVARCHAR(200) NULL,                     -- NULL until first successful sync (unless given)
  Status VARCHAR(16) NOT NULL CONSTRAINT DF_Projects_Status DEFAULT 'validating',
  StatusDetail NVARCHAR(2000) NULL,
  TestCommandJson NVARCHAR(MAX) NULL,
  TestTimeoutSeconds INT NOT NULL CONSTRAINT DF_Projects_TestTimeoutSeconds DEFAULT 900,
  JUnitReportPath NVARCHAR(400) NULL,
  RequireIndex BIT NOT NULL CONSTRAINT DF_Projects_RequireIndex DEFAULT 0,
  AutoIndex BIT NOT NULL CONSTRAINT DF_Projects_AutoIndex DEFAULT 1,
  IndexMode VARCHAR(16) NOT NULL CONSTRAINT DF_Projects_IndexMode DEFAULT 'moderate',
  DefaultAgentId UNIQUEIDENTIFIER NULL,
  DefaultTimeoutSeconds INT NOT NULL CONSTRAINT DF_Projects_DefaultTimeoutSeconds DEFAULT 3600,
  WorkspaceMaxBytes BIGINT NULL,
  HeadSha VARCHAR(64) NULL,
  LastSyncedAt DATETIME2(3) NULL,
  LastIndexedAt DATETIME2(3) NULL,
  LastIndexOperationId UNIQUEIDENTIFIER NULL,           -- no FK (avoids Projects<->McpIndexOperations cycle)
  CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
  ArchivedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Projects_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Projects_UpdatedAt DEFAULT SYSUTCDATETIME(),
  RowVer ROWVERSION NOT NULL,
  CONSTRAINT PK_Projects PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_Projects_Name UNIQUE (Name),
  CONSTRAINT UQ_Projects_RepoPath UNIQUE (RepoPath),
  CONSTRAINT FK_Projects_Agents_DefaultAgentId FOREIGN KEY (DefaultAgentId) REFERENCES orc.Agents (Id),
  CONSTRAINT FK_Projects_Users_CreatedByUserId FOREIGN KEY (CreatedByUserId) REFERENCES orc.Users (Id),
  CONSTRAINT CK_Projects_Status CHECK (Status IN ('validating','ready','invalid','archived')),
  CONSTRAINT CK_Projects_IndexMode CHECK (IndexMode IN ('full','moderate','fast')),
  CONSTRAINT CK_Projects_TestCommandJson CHECK (TestCommandJson IS NULL OR ISJSON(TestCommandJson, ARRAY) = 1),
  CONSTRAINT CK_Projects_TestTimeoutSeconds CHECK (TestTimeoutSeconds BETWEEN 30 AND 7200),
  CONSTRAINT CK_Projects_DefaultTimeoutSeconds CHECK (DefaultTimeoutSeconds BETWEEN 60 AND 86400),
  CONSTRAINT CK_Projects_WorkspaceMaxBytes CHECK (WorkspaceMaxBytes IS NULL OR WorkspaceMaxBytes >= 104857600),
  CONSTRAINT CK_Projects_Archived CHECK ((Status = 'archived' AND ArchivedAt IS NOT NULL) OR (Status <> 'archived' AND ArchivedAt IS NULL))
);
CREATE INDEX IX_Projects_List ON orc.Projects (CreatedAt DESC, Id DESC) INCLUDE (Status);
GO

CREATE TABLE orc.Tasks (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Tasks_Id DEFAULT NEWSEQUENTIALID(),
  ProjectId UNIQUEIDENTIFIER NOT NULL,
  AgentId UNIQUEIDENTIFIER NOT NULL,
  CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
  Title NVARCHAR(200) NOT NULL,
  Prompt NVARCHAR(MAX) NOT NULL,
  AcceptanceCriteria NVARCHAR(MAX) NULL,
  Scope NVARCHAR(4000) NULL,
  BaseRef NVARCHAR(200) NULL,
  Model NVARCHAR(100) NOT NULL,
  Effort VARCHAR(8) NULL,
  TimeoutSeconds INT NOT NULL,
  MaxBudgetUsd DECIMAL(10,4) NULL,
  Status VARCHAR(24) NOT NULL CONSTRAINT DF_Tasks_Status DEFAULT 'created',
  StatusReason VARCHAR(40) NULL,
  StatusDetail NVARCHAR(2000) NULL,
  CurrentAttemptId UNIQUEIDENTIFIER NULL,               -- FK added after TaskAttempts
  AttemptCount INT NOT NULL CONSTRAINT DF_Tasks_AttemptCount DEFAULT 0,
  AutoRecoveryCount INT NOT NULL CONSTRAINT DF_Tasks_AutoRecoveryCount DEFAULT 0,
  CancelRequestedAt DATETIME2(3) NULL,
  CancelRequestedByUserId UNIQUEIDENTIFIER NULL,
  CorrelationId VARCHAR(128) NULL,
  QueuedAt DATETIME2(3) NULL,
  StartedAt DATETIME2(3) NULL,
  FinishedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Tasks_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Tasks_UpdatedAt DEFAULT SYSUTCDATETIME(),
  RowVer ROWVERSION NOT NULL,
  CONSTRAINT PK_Tasks PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_Tasks_Projects FOREIGN KEY (ProjectId) REFERENCES orc.Projects (Id),
  CONSTRAINT FK_Tasks_Agents FOREIGN KEY (AgentId) REFERENCES orc.Agents (Id),
  CONSTRAINT FK_Tasks_Users_CreatedByUserId FOREIGN KEY (CreatedByUserId) REFERENCES orc.Users (Id),
  CONSTRAINT FK_Tasks_Users_CancelRequestedByUserId FOREIGN KEY (CancelRequestedByUserId) REFERENCES orc.Users (Id),
  CONSTRAINT CK_Tasks_Status CHECK (Status IN ('created','queued','preparing_workspace','indexing','running','testing','reviewing','completed','failed','timed_out','cancelled','blocked')),
  CONSTRAINT CK_Tasks_StatusReason CHECK (StatusReason IS NULL OR StatusReason IN ('cancelled_by_user','timeout','project_unavailable','base_ref_not_found','insufficient_disk_space','index_required_failed','workspace_error','disk_quota_exceeded','claude_cli_unavailable','claude_start_failed','security_violation','claude_exit_nonzero','claude_result_error','claude_protocol_error','budget_exceeded','output_limit_exceeded','prompt_too_large','test_failed','test_command_error','test_timeout','review_failed','worker_shutdown','worker_lost','recovery_limit_reached','queue_exhausted','invalid_job','internal_error')),
  CONSTRAINT CK_Tasks_Effort CHECK (Effort IS NULL OR Effort IN ('low','medium','high')),
  CONSTRAINT CK_Tasks_TimeoutSeconds CHECK (TimeoutSeconds BETWEEN 60 AND 86400),
  CONSTRAINT CK_Tasks_MaxBudgetUsd CHECK (MaxBudgetUsd IS NULL OR MaxBudgetUsd > 0),
  CONSTRAINT CK_Tasks_Prompt CHECK (DATALENGTH(Prompt) BETWEEN 2 AND 200000),   -- 1..100000 chars incl. trailing spaces (LEN ignores them)
  CONSTRAINT CK_Tasks_Counters CHECK (AttemptCount >= 0 AND AutoRecoveryCount >= 0)
);
CREATE INDEX IX_Tasks_Owner ON orc.Tasks (CreatedByUserId, CreatedAt DESC, Id DESC) INCLUDE (Status, ProjectId);
CREATE INDEX IX_Tasks_Project ON orc.Tasks (ProjectId, CreatedAt DESC, Id DESC) INCLUDE (Status, CreatedByUserId);
CREATE INDEX IX_Tasks_List ON orc.Tasks (CreatedAt DESC, Id DESC) INCLUDE (Status, ProjectId, CreatedByUserId);
CREATE INDEX IX_Tasks_Queued ON orc.Tasks (QueuedAt) INCLUDE (CurrentAttemptId) WHERE Status = 'queued';
CREATE INDEX IX_Tasks_CancelRequested ON orc.Tasks (CancelRequestedAt) WHERE CancelRequestedAt IS NOT NULL;
GO

CREATE TABLE orc.Workspaces (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Workspaces_Id DEFAULT NEWSEQUENTIALID(),
  ProjectId UNIQUEIDENTIFIER NOT NULL,
  TaskId UNIQUEIDENTIFIER NULL,
  Kind VARCHAR(8) NOT NULL,
  CreatedByAttemptId UNIQUEIDENTIFIER NULL,             -- FK added after TaskAttempts
  Path NVARCHAR(400) NOT NULL,                          -- relative to WORKSPACES_ROOT, '/' separated
  BranchName NVARCHAR(200) NULL,
  BaseSha VARCHAR(64) NULL,
  HeadSha VARCHAR(64) NULL,
  Status VARCHAR(10) NOT NULL CONSTRAINT DF_Workspaces_Status DEFAULT 'creating',
  WorkerId NVARCHAR(128) NULL,
  QuotaBytes BIGINT NOT NULL,
  SizeBytes BIGINT NULL,
  SizeCheckedAt DATETIME2(3) NULL,
  RetainUntil DATETIME2(3) NULL,
  ErrorDetail NVARCHAR(2000) NULL,
  RemovedAt DATETIME2(3) NULL,
  BranchDeletedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Workspaces_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Workspaces_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_Workspaces PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_Workspaces_Projects FOREIGN KEY (ProjectId) REFERENCES orc.Projects (Id),
  CONSTRAINT FK_Workspaces_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT CK_Workspaces_Kind CHECK (Kind IN ('attempt','base')),
  CONSTRAINT CK_Workspaces_Status CHECK (Status IN ('creating','ready','in_use','retained','removing','removed','error')),
  CONSTRAINT CK_Workspaces_KindShape CHECK ((Kind = 'base' AND TaskId IS NULL AND BranchName IS NULL) OR (Kind = 'attempt' AND TaskId IS NOT NULL AND BranchName IS NOT NULL)),
  CONSTRAINT CK_Workspaces_QuotaBytes CHECK (QuotaBytes > 0)
);
CREATE UNIQUE INDEX UX_Workspaces_Path_Live ON orc.Workspaces (Path) WHERE Status <> 'removed';
CREATE UNIQUE INDEX UX_Workspaces_Base_Live ON orc.Workspaces (ProjectId) WHERE Kind = 'base' AND Status <> 'removed';
CREATE INDEX IX_Workspaces_Cleanup ON orc.Workspaces (RetainUntil) INCLUDE (Status, Kind, TaskId) WHERE Status IN ('ready','retained','error');
CREATE INDEX IX_Workspaces_Task ON orc.Workspaces (TaskId) WHERE TaskId IS NOT NULL;
GO

CREATE TABLE orc.TaskAttempts (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TaskAttempts_Id DEFAULT NEWSEQUENTIALID(),
  TaskId UNIQUEIDENTIFIER NOT NULL,
  AttemptNumber INT NOT NULL,
  TriggerKind VARCHAR(16) NOT NULL,
  Mode VARCHAR(8) NOT NULL,
  PreviousAttemptId UNIQUEIDENTIFIER NULL,
  Status VARCHAR(12) NOT NULL CONSTRAINT DF_TaskAttempts_Status DEFAULT 'queued',
  Stage VARCHAR(24) NULL,                               -- last active stage reached
  FailureReason VARCHAR(40) NULL,
  FailureDetail NVARCHAR(2000) NULL,
  AdditionalInstructions NVARCHAR(MAX) NULL,
  BaseRefOverride NVARCHAR(200) NULL,
  WorkspaceId UNIQUEIDENTIFIER NULL,
  BranchName NVARCHAR(200) NULL,
  BaseSha VARCHAR(64) NULL,
  HeadSha VARCHAR(64) NULL,
  WorkerId NVARCHAR(128) NULL,
  Pid INT NULL,
  Pgid INT NULL,
  ProcessStartedAt DATETIME2(3) NULL,
  ProcessEndedAt DATETIME2(3) NULL,
  ExitCode INT NULL,
  ExitSignal VARCHAR(16) NULL,
  TimeoutSeconds INT NOT NULL,
  DeadlineAt DATETIME2(3) NULL,
  QueuedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TaskAttempts_QueuedAt DEFAULT SYSUTCDATETIME(),
  StartedAt DATETIME2(3) NULL,
  EndedAt DATETIME2(3) NULL,
  LastHeartbeatAt DATETIME2(3) NULL,
  FilesChanged INT NULL,
  Additions INT NULL,
  Deletions INT NULL,
  CommitsJson NVARCHAR(MAX) NULL,
  MergeCheckJson NVARCHAR(MAX) NULL,
  CorrelationId VARCHAR(128) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TaskAttempts_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TaskAttempts_UpdatedAt DEFAULT SYSUTCDATETIME(),
  RowVer ROWVERSION NOT NULL,
  CONSTRAINT PK_TaskAttempts PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_TaskAttempts_TaskId_AttemptNumber UNIQUE (TaskId, AttemptNumber),
  CONSTRAINT FK_TaskAttempts_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT FK_TaskAttempts_PreviousAttempt FOREIGN KEY (PreviousAttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT FK_TaskAttempts_Workspaces FOREIGN KEY (WorkspaceId) REFERENCES orc.Workspaces (Id),
  CONSTRAINT CK_TaskAttempts_Status CHECK (Status IN ('queued','active','succeeded','failed','timed_out','cancelled','blocked','interrupted')),
  CONSTRAINT CK_TaskAttempts_TriggerKind CHECK (TriggerKind IN ('initial','user_retry','infra_recovery')),
  CONSTRAINT CK_TaskAttempts_Mode CHECK (Mode IN ('fresh','continue','resume')),
  CONSTRAINT CK_TaskAttempts_Stage CHECK (Stage IS NULL OR Stage IN ('preparing_workspace','indexing','running','testing','reviewing')),
  CONSTRAINT CK_TaskAttempts_FailureReason CHECK (FailureReason IS NULL OR FailureReason IN (/* identical list to CK_Tasks_StatusReason */ 'cancelled_by_user','timeout','project_unavailable','base_ref_not_found','insufficient_disk_space','index_required_failed','workspace_error','disk_quota_exceeded','claude_cli_unavailable','claude_start_failed','security_violation','claude_exit_nonzero','claude_result_error','claude_protocol_error','budget_exceeded','output_limit_exceeded','prompt_too_large','test_failed','test_command_error','test_timeout','review_failed','worker_shutdown','worker_lost','recovery_limit_reached','queue_exhausted','invalid_job','internal_error')),
  CONSTRAINT CK_TaskAttempts_AttemptNumber CHECK (AttemptNumber >= 1),
  CONSTRAINT CK_TaskAttempts_TimeoutSeconds CHECK (TimeoutSeconds BETWEEN 60 AND 86400),
  CONSTRAINT CK_TaskAttempts_CommitsJson CHECK (CommitsJson IS NULL OR ISJSON(CommitsJson, ARRAY) = 1),
  CONSTRAINT CK_TaskAttempts_MergeCheckJson CHECK (MergeCheckJson IS NULL OR ISJSON(MergeCheckJson, OBJECT) = 1)
);
CREATE UNIQUE INDEX UX_TaskAttempts_OneLivePerTask ON orc.TaskAttempts (TaskId) WHERE Status IN ('queued','active');
CREATE INDEX IX_TaskAttempts_ActiveHeartbeat ON orc.TaskAttempts (LastHeartbeatAt) INCLUDE (TaskId, WorkerId) WHERE Status = 'active';
CREATE INDEX IX_TaskAttempts_ActiveWorker ON orc.TaskAttempts (WorkerId) INCLUDE (TaskId) WHERE Status = 'active';
CREATE INDEX IX_TaskAttempts_Workspace ON orc.TaskAttempts (WorkspaceId) WHERE WorkspaceId IS NOT NULL;
ALTER TABLE orc.Tasks ADD CONSTRAINT FK_Tasks_TaskAttempts_CurrentAttemptId FOREIGN KEY (CurrentAttemptId) REFERENCES orc.TaskAttempts (Id);
ALTER TABLE orc.Workspaces ADD CONSTRAINT FK_Workspaces_TaskAttempts_CreatedByAttemptId FOREIGN KEY (CreatedByAttemptId) REFERENCES orc.TaskAttempts (Id);
GO

CREATE TABLE orc.TaskLogs (
  Id BIGINT IDENTITY(1,1) NOT NULL,
  TaskId UNIQUEIDENTIFIER NOT NULL,
  AttemptId UNIQUEIDENTIFIER NOT NULL,
  Seq INT NOT NULL,                                     -- 0-based, per attempt, gap-free, single writer
  Stream VARCHAR(8) NOT NULL,
  Source VARCHAR(16) NOT NULL,
  Content NVARCHAR(4000) NOT NULL,
  ByteLength INT NOT NULL,                              -- UTF-8 bytes of Content
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TaskLogs_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_TaskLogs PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_TaskLogs_AttemptId_Seq UNIQUE (AttemptId, Seq),
  CONSTRAINT FK_TaskLogs_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT FK_TaskLogs_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT CK_TaskLogs_Stream CHECK (Stream IN ('stdout','stderr','system','claude')),
  CONSTRAINT CK_TaskLogs_Source CHECK (Source IN ('claude','test','orchestrator','git','mcp')),
  CONSTRAINT CK_TaskLogs_Seq CHECK (Seq >= 0),
  CONSTRAINT CK_TaskLogs_ByteLength CHECK (ByteLength BETWEEN 0 AND 12000)
);
CREATE INDEX IX_TaskLogs_Task ON orc.TaskLogs (TaskId, Id);
CREATE INDEX IX_TaskLogs_CreatedAt ON orc.TaskLogs (CreatedAt);
GO

CREATE TABLE orc.TaskEvents (
  Id BIGINT IDENTITY(1,1) NOT NULL,
  TaskId UNIQUEIDENTIFIER NOT NULL,
  AttemptId UNIQUEIDENTIFIER NULL,
  EventType VARCHAR(32) NOT NULL,
  FromStatus VARCHAR(24) NULL,
  ToStatus VARCHAR(24) NULL,
  ActorType VARCHAR(8) NOT NULL,
  ActorUserId UNIQUEIDENTIFIER NULL,
  ActorLabel NVARCHAR(200) NULL,
  Reason VARCHAR(40) NULL,
  DataJson NVARCHAR(MAX) NULL,
  CorrelationId VARCHAR(128) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TaskEvents_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_TaskEvents PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_TaskEvents_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT FK_TaskEvents_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT FK_TaskEvents_Users FOREIGN KEY (ActorUserId) REFERENCES orc.Users (Id),
  CONSTRAINT CK_TaskEvents_EventType CHECK (EventType IN ('task_created','status_changed','attempt_created','attempt_claimed','cancel_requested','workspace_ready','index_started','index_completed','index_failed','claude_started','claude_init','claude_exited','test_started','test_completed','review_completed','artifacts_captured','recovery_scheduled','resume_fallback','orphan_killed','security_violation','warning')),
  CONSTRAINT CK_TaskEvents_ActorType CHECK (ActorType IN ('user','token','worker','system')),
  CONSTRAINT CK_TaskEvents_Statuses CHECK ((FromStatus IS NULL OR FromStatus IN ('created','queued','preparing_workspace','indexing','running','testing','reviewing','completed','failed','timed_out','cancelled','blocked')) AND (ToStatus IS NULL OR ToStatus IN ('created','queued','preparing_workspace','indexing','running','testing','reviewing','completed','failed','timed_out','cancelled','blocked'))),
  CONSTRAINT CK_TaskEvents_DataJson CHECK (DataJson IS NULL OR ISJSON(DataJson, OBJECT) = 1)
);
CREATE INDEX IX_TaskEvents_Task ON orc.TaskEvents (TaskId, Id);
GO

CREATE TABLE orc.ClaudeSessions (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ClaudeSessions_Id DEFAULT NEWSEQUENTIALID(),
  AttemptId UNIQUEIDENTIFIER NOT NULL,
  TaskId UNIQUEIDENTIFIER NOT NULL,
  SessionId VARCHAR(64) NULL,
  ResumedFromSessionId VARCHAR(64) NULL,
  RunCount INT NOT NULL CONSTRAINT DF_ClaudeSessions_RunCount DEFAULT 1,                      -- Claude runs in this attempt (resume fallback => 2); start() is an upsert (T-M5)
  Status VARCHAR(10) NOT NULL CONSTRAINT DF_ClaudeSessions_Status DEFAULT 'starting',
  Model NVARCHAR(100) NOT NULL,
  CliVersion VARCHAR(32) NULL,
  PermissionMode VARCHAR(24) NOT NULL,
  ToolsJson NVARCHAR(MAX) NULL,
  McpServersJson NVARCHAR(MAX) NULL,
  ApiKeySource VARCHAR(64) NULL,
  ResultSubtype VARCHAR(64) NULL,
  IsError BIT NULL,
  StopReason VARCHAR(64) NULL,
  TerminalReason VARCHAR(64) NULL,
  NumTurns INT NULL,
  TotalCostUsd DECIMAL(12,6) NULL,
  InputTokens BIGINT NULL,
  OutputTokens BIGINT NULL,
  CacheCreationInputTokens BIGINT NULL,
  CacheReadInputTokens BIGINT NULL,
  DurationMs BIGINT NULL,
  DurationApiMs BIGINT NULL,
  PermissionDenialsCount INT NULL,
  PermissionDenialsJson NVARCHAR(MAX) NULL,             -- capped 64 KiB
  ResultText NVARCHAR(MAX) NULL,                        -- capped 64 KiB, masked
  StartedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ClaudeSessions_StartedAt DEFAULT SYSUTCDATETIME(),
  InitAt DATETIME2(3) NULL,
  EndedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ClaudeSessions_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ClaudeSessions_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_ClaudeSessions PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_ClaudeSessions_AttemptId UNIQUE (AttemptId),
  CONSTRAINT FK_ClaudeSessions_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT FK_ClaudeSessions_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT CK_ClaudeSessions_Status CHECK (Status IN ('starting','running','completed','failed','killed')),
  CONSTRAINT CK_ClaudeSessions_ToolsJson CHECK (ToolsJson IS NULL OR ISJSON(ToolsJson, ARRAY) = 1),
  CONSTRAINT CK_ClaudeSessions_McpServersJson CHECK (McpServersJson IS NULL OR ISJSON(McpServersJson, ARRAY) = 1),
  CONSTRAINT CK_ClaudeSessions_PermissionDenialsJson CHECK (PermissionDenialsJson IS NULL OR ISJSON(PermissionDenialsJson, ARRAY) = 1)
);
CREATE INDEX IX_ClaudeSessions_Task ON orc.ClaudeSessions (TaskId, CreatedAt DESC);
GO

CREATE TABLE orc.ChangedFiles (
  Id BIGINT IDENTITY(1,1) NOT NULL,
  AttemptId UNIQUEIDENTIFIER NOT NULL,
  TaskId UNIQUEIDENTIFIER NOT NULL,
  Path NVARCHAR(1024) NOT NULL,
  PathHash AS CAST(HASHBYTES('SHA2_256', Path) AS BINARY(32)) PERSISTED,
  OldPath NVARCHAR(1024) NULL,
  ChangeType CHAR(1) NOT NULL,
  Similarity TINYINT NULL,
  Additions INT NULL,                                   -- NULL for binary
  Deletions INT NULL,
  IsBinary BIT NOT NULL CONSTRAINT DF_ChangedFiles_IsBinary DEFAULT 0,
  Patch NVARCHAR(MAX) NULL,                             -- unified diff of this file, capped CHANGED_FILE_PATCH_MAX_BYTES
  PatchBytes INT NOT NULL CONSTRAINT DF_ChangedFiles_PatchBytes DEFAULT 0,                    -- UTF-8 bytes of the untruncated patch
  PatchTruncated BIT NOT NULL CONSTRAINT DF_ChangedFiles_PatchTruncated DEFAULT 0,
  PatchPurgedAt DATETIME2(3) NULL,                      -- PATCH_RETENTION_DAYS purge sets Patch = NULL (F12)
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ChangedFiles_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_ChangedFiles PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_ChangedFiles_AttemptId_PathHash UNIQUE (AttemptId, PathHash),
  CONSTRAINT FK_ChangedFiles_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id) ON DELETE CASCADE,
  CONSTRAINT FK_ChangedFiles_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT CK_ChangedFiles_ChangeType CHECK (ChangeType IN ('A','M','D','R','C','T')),
  CONSTRAINT CK_ChangedFiles_OldPath CHECK ((ChangeType IN ('R','C') AND OldPath IS NOT NULL) OR (ChangeType NOT IN ('R','C') AND OldPath IS NULL)),
  CONSTRAINT CK_ChangedFiles_Similarity CHECK (Similarity IS NULL OR Similarity <= 100)
);
GO

CREATE TABLE orc.AttemptPatches (
  AttemptId UNIQUEIDENTIFIER NOT NULL,
  Format VARCHAR(16) NOT NULL CONSTRAINT DF_AttemptPatches_Format DEFAULT 'format-patch',
  ByteLength BIGINT NOT NULL,                           -- uncompressed bytes
  Sha256 BINARY(32) NOT NULL,                           -- of uncompressed bytes
  ContentGzip VARBINARY(MAX) NULL,
  TooLarge BIT NOT NULL CONSTRAINT DF_AttemptPatches_TooLarge DEFAULT 0,
  PurgedAt DATETIME2(3) NULL,                           -- PATCH_RETENTION_DAYS purge (F12)
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_AttemptPatches_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_AttemptPatches PRIMARY KEY CLUSTERED (AttemptId),
  CONSTRAINT FK_AttemptPatches_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id) ON DELETE CASCADE,
  CONSTRAINT CK_AttemptPatches_Format CHECK (Format IN ('format-patch')),
  CONSTRAINT CK_AttemptPatches_Content CHECK ((PurgedAt IS NOT NULL AND ContentGzip IS NULL) OR (PurgedAt IS NULL AND ((TooLarge = 1 AND ContentGzip IS NULL) OR (TooLarge = 0 AND ContentGzip IS NOT NULL))))
);
GO

CREATE TABLE orc.TestRuns (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TestRuns_Id DEFAULT NEWSEQUENTIALID(),
  AttemptId UNIQUEIDENTIFIER NOT NULL,
  TaskId UNIQUEIDENTIFIER NOT NULL,
  CommandJson NVARCHAR(MAX) NOT NULL,
  JUnitPath NVARCHAR(400) NULL,
  Status VARCHAR(10) NOT NULL CONSTRAINT DF_TestRuns_Status DEFAULT 'running',
  ExitCode INT NULL,
  Signal VARCHAR(16) NULL,
  DurationMs BIGINT NULL,
  Total INT NOT NULL CONSTRAINT DF_TestRuns_Total DEFAULT 0,
  Passed INT NOT NULL CONSTRAINT DF_TestRuns_Passed DEFAULT 0,
  Failed INT NOT NULL CONSTRAINT DF_TestRuns_Failed DEFAULT 0,
  Errored INT NOT NULL CONSTRAINT DF_TestRuns_Errored DEFAULT 0,
  Skipped INT NOT NULL CONSTRAINT DF_TestRuns_Skipped DEFAULT 0,
  ReportParsed BIT NOT NULL CONSTRAINT DF_TestRuns_ReportParsed DEFAULT 0,
  ReportError NVARCHAR(1000) NULL,
  StartedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TestRuns_StartedAt DEFAULT SYSUTCDATETIME(),
  EndedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TestRuns_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_TestRuns PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_TestRuns_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT FK_TestRuns_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT CK_TestRuns_Status CHECK (Status IN ('running','passed','failed','error','timed_out','cancelled')),
  CONSTRAINT CK_TestRuns_CommandJson CHECK (ISJSON(CommandJson, ARRAY) = 1),
  CONSTRAINT CK_TestRuns_Counts CHECK (Total >= 0 AND Passed >= 0 AND Failed >= 0 AND Errored >= 0 AND Skipped >= 0)
);
CREATE INDEX IX_TestRuns_Attempt ON orc.TestRuns (AttemptId, StartedAt);
GO

CREATE TABLE orc.TestResults (
  Id BIGINT IDENTITY(1,1) NOT NULL,
  TestRunId UNIQUEIDENTIFIER NOT NULL,
  SuiteName NVARCHAR(400) NULL,
  ClassName NVARCHAR(400) NULL,
  Name NVARCHAR(400) NOT NULL,
  FilePath NVARCHAR(400) NULL,
  Status VARCHAR(8) NOT NULL,
  DurationMs INT NULL,
  FailureType NVARCHAR(200) NULL,
  FailureMessage NVARCHAR(4000) NULL,
  FailureDetail NVARCHAR(MAX) NULL,                     -- capped 16 KiB
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TestResults_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_TestResults PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_TestResults_TestRuns FOREIGN KEY (TestRunId) REFERENCES orc.TestRuns (Id) ON DELETE CASCADE,
  CONSTRAINT CK_TestResults_Status CHECK (Status IN ('passed','failed','error','skipped'))
);
CREATE INDEX IX_TestResults_Run ON orc.TestResults (TestRunId, Status, Id);
GO

CREATE TABLE orc.GitOperations (
  Id BIGINT IDENTITY(1,1) NOT NULL,
  ProjectId UNIQUEIDENTIFIER NOT NULL,
  TaskId UNIQUEIDENTIFIER NULL,
  AttemptId UNIQUEIDENTIFIER NULL,
  WorkerId NVARCHAR(128) NOT NULL,
  Operation VARCHAR(24) NOT NULL,
  ArgsJson NVARCHAR(MAX) NOT NULL,                      -- sanitized argv (§11.7)
  Cwd NVARCHAR(400) NULL,                               -- tokenized path
  ExitCode INT NULL,
  Signal VARCHAR(16) NULL,
  Success BIT NOT NULL,
  TimedOut BIT NOT NULL CONSTRAINT DF_GitOperations_TimedOut DEFAULT 0,
  DurationMs INT NOT NULL,
  StderrTail NVARCHAR(4000) NULL,                       -- masked
  CorrelationId VARCHAR(128) NULL,
  StartedAt DATETIME2(3) NOT NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_GitOperations_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_GitOperations PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_GitOperations_Projects FOREIGN KEY (ProjectId) REFERENCES orc.Projects (Id),
  CONSTRAINT FK_GitOperations_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT FK_GitOperations_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT CK_GitOperations_Operation CHECK (Operation IN ('version','validate_source','mirror_init','mirror_config','mirror_fetch','resolve_ref','list_branches','worktree_add','worktree_lock','worktree_unlock','worktree_remove','worktree_prune','worktree_list','add','diff_cached_quiet','commit','rev_parse','rev_list','log','diff_name_status','diff_numstat','diff_patch','format_patch','merge_tree','merge_base','branch_delete','gc')),
  CONSTRAINT CK_GitOperations_ArgsJson CHECK (ISJSON(ArgsJson, ARRAY) = 1)
);
CREATE INDEX IX_GitOperations_Attempt ON orc.GitOperations (AttemptId, Id) WHERE AttemptId IS NOT NULL;
CREATE INDEX IX_GitOperations_Project ON orc.GitOperations (ProjectId, Id);
CREATE INDEX IX_GitOperations_CreatedAt ON orc.GitOperations (CreatedAt);
GO

CREATE TABLE orc.McpIndexOperations (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_McpIndexOperations_Id DEFAULT NEWSEQUENTIALID(),
  ProjectId UNIQUEIDENTIFIER NOT NULL,
  TaskId UNIQUEIDENTIFIER NULL,
  AttemptId UNIQUEIDENTIFIER NULL,
  WorkspaceId UNIQUEIDENTIFIER NULL,
  Kind VARCHAR(16) NOT NULL,
  IndexName NVARCHAR(128) NOT NULL,
  Mode VARCHAR(16) NULL,
  Status VARCHAR(10) NOT NULL,
  RequestedByUserId UNIQUEIDENTIFIER NULL,
  WorkerId NVARCHAR(128) NULL,
  StartedAt DATETIME2(3) NULL,
  EndedAt DATETIME2(3) NULL,
  DurationMs BIGINT NULL,
  NodeCount BIGINT NULL,
  EdgeCount BIGINT NULL,
  ResultJson NVARCHAR(MAX) NULL,                        -- capped MCP_RESULT_MAX_BYTES
  ErrorCode VARCHAR(40) NULL,
  ErrorMessage NVARCHAR(2000) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_McpIndexOperations_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_McpIndexOperations_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_McpIndexOperations PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT FK_McpIndexOperations_Projects FOREIGN KEY (ProjectId) REFERENCES orc.Projects (Id),
  CONSTRAINT FK_McpIndexOperations_Tasks FOREIGN KEY (TaskId) REFERENCES orc.Tasks (Id),
  CONSTRAINT FK_McpIndexOperations_TaskAttempts FOREIGN KEY (AttemptId) REFERENCES orc.TaskAttempts (Id),
  CONSTRAINT FK_McpIndexOperations_Workspaces FOREIGN KEY (WorkspaceId) REFERENCES orc.Workspaces (Id),
  CONSTRAINT FK_McpIndexOperations_Users FOREIGN KEY (RequestedByUserId) REFERENCES orc.Users (Id),
  CONSTRAINT CK_McpIndexOperations_Kind CHECK (Kind IN ('project_index','task_index','task_reindex','impact_analysis','index_delete')),
  CONSTRAINT CK_McpIndexOperations_Mode CHECK (Mode IS NULL OR Mode IN ('full','moderate','fast')),
  CONSTRAINT CK_McpIndexOperations_Status CHECK (Status IN ('queued','running','succeeded','failed','skipped')),
  CONSTRAINT CK_McpIndexOperations_ResultJson CHECK (ResultJson IS NULL OR ISJSON(ResultJson) = 1)
);
CREATE UNIQUE INDEX UX_McpIndexOperations_ActiveProjectIndex ON orc.McpIndexOperations (ProjectId) WHERE Kind = 'project_index' AND Status IN ('queued','running');
CREATE INDEX IX_McpIndexOperations_Project ON orc.McpIndexOperations (ProjectId, CreatedAt DESC, Id DESC) INCLUDE (Kind, Status);
CREATE INDEX IX_McpIndexOperations_Attempt ON orc.McpIndexOperations (AttemptId, Kind) WHERE AttemptId IS NOT NULL;
CREATE INDEX IX_McpIndexOperations_CreatedAt ON orc.McpIndexOperations (CreatedAt);
GO

CREATE TABLE orc.AuditLogs (                             -- no FKs: audit must never block or be cascaded
  Id BIGINT IDENTITY(1,1) NOT NULL,
  OccurredAt DATETIME2(3) NOT NULL CONSTRAINT DF_AuditLogs_OccurredAt DEFAULT SYSUTCDATETIME(),
  Action VARCHAR(64) NOT NULL,
  Outcome VARCHAR(8) NOT NULL,
  ActorType VARCHAR(8) NOT NULL,
  ActorUserId UNIQUEIDENTIFIER NULL,
  ActorTokenId UNIQUEIDENTIFIER NULL,
  ActorLabel NVARCHAR(200) NOT NULL,
  EntityType VARCHAR(24) NOT NULL,
  EntityId NVARCHAR(64) NULL,
  BeforeJson NVARCHAR(MAX) NULL,                        -- masked
  AfterJson NVARCHAR(MAX) NULL,                         -- masked
  DetailJson NVARCHAR(MAX) NULL,                        -- masked
  Ip VARCHAR(45) NULL,
  UserAgent NVARCHAR(400) NULL,
  RequestId VARCHAR(128) NULL,
  CorrelationId VARCHAR(128) NULL,
  CONSTRAINT PK_AuditLogs PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT CK_AuditLogs_Action CHECK (Action LIKE '[a-z]%.[a-z]%' AND Action NOT LIKE '%[^a-z0-9._]%'),
  CONSTRAINT CK_AuditLogs_Outcome CHECK (Outcome IN ('success','failure','denied')),
  CONSTRAINT CK_AuditLogs_ActorType CHECK (ActorType IN ('user','token','worker','system')),
  CONSTRAINT CK_AuditLogs_EntityType CHECK (EntityType IN ('user','session','api_token','project','task','attempt','agent','team','worker','index_operation','system')),
  CONSTRAINT CK_AuditLogs_Json CHECK ((BeforeJson IS NULL OR ISJSON(BeforeJson) = 1) AND (AfterJson IS NULL OR ISJSON(AfterJson) = 1) AND (DetailJson IS NULL OR ISJSON(DetailJson) = 1))
);
CREATE INDEX IX_AuditLogs_OccurredAt ON orc.AuditLogs (OccurredAt DESC, Id DESC);
CREATE INDEX IX_AuditLogs_Entity ON orc.AuditLogs (EntityType, EntityId, Id DESC);
CREATE INDEX IX_AuditLogs_Actor ON orc.AuditLogs (ActorUserId, Id DESC) WHERE ActorUserId IS NOT NULL;
CREATE INDEX IX_AuditLogs_Action ON orc.AuditLogs (Action, Id DESC);
GO

CREATE TABLE orc.AuthSessions (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_AuthSessions_Id DEFAULT NEWSEQUENTIALID(),
  UserId UNIQUEIDENTIFIER NOT NULL,
  TokenHash BINARY(32) NOT NULL,                        -- SHA-256 of cookie token
  CsrfToken VARCHAR(64) NOT NULL,
  ExpiresAt DATETIME2(3) NOT NULL,                      -- absolute
  IdleExpiresAt DATETIME2(3) NOT NULL,                  -- sliding
  LastSeenAt DATETIME2(3) NOT NULL CONSTRAINT DF_AuthSessions_LastSeenAt DEFAULT SYSUTCDATETIME(),
  RevokedAt DATETIME2(3) NULL,
  RevokedReason VARCHAR(32) NULL,
  Ip VARCHAR(45) NULL,
  UserAgent NVARCHAR(400) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_AuthSessions_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_AuthSessions PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_AuthSessions_TokenHash UNIQUE (TokenHash),
  CONSTRAINT FK_AuthSessions_Users FOREIGN KEY (UserId) REFERENCES orc.Users (Id),
  CONSTRAINT CK_AuthSessions_Expiry CHECK (ExpiresAt > CreatedAt AND IdleExpiresAt <= ExpiresAt)
);
CREATE INDEX IX_AuthSessions_User ON orc.AuthSessions (UserId) WHERE RevokedAt IS NULL;
CREATE INDEX IX_AuthSessions_ExpiresAt ON orc.AuthSessions (ExpiresAt);
GO

CREATE TABLE orc.ApiTokens (
  Id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ApiTokens_Id DEFAULT NEWSEQUENTIALID(),
  UserId UNIQUEIDENTIFIER NOT NULL,
  Name NVARCHAR(100) NOT NULL,
  Prefix VARCHAR(16) NOT NULL,
  TokenHash BINARY(32) NOT NULL,
  ReadOnly BIT NOT NULL CONSTRAINT DF_ApiTokens_ReadOnly DEFAULT 0,
  ExpiresAt DATETIME2(3) NOT NULL,
  LastUsedAt DATETIME2(3) NULL,
  RevokedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ApiTokens_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_ApiTokens PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_ApiTokens_TokenHash UNIQUE (TokenHash),
  CONSTRAINT UQ_ApiTokens_UserId_Name UNIQUE (UserId, Name),
  CONSTRAINT FK_ApiTokens_Users FOREIGN KEY (UserId) REFERENCES orc.Users (Id)
);
GO

CREATE TABLE orc.IdempotencyKeys (
  Id BIGINT IDENTITY(1,1) NOT NULL,
  UserId UNIQUEIDENTIFIER NOT NULL,
  Scope VARCHAR(64) NOT NULL,                           -- e.g. 'POST /api/v1/tasks'
  KeyValue VARCHAR(255) NOT NULL,
  RequestHash BINARY(32) NOT NULL,
  Status VARCHAR(12) NOT NULL CONSTRAINT DF_IdempotencyKeys_Status DEFAULT 'in_progress',
  ResponseStatus INT NULL,
  ResponseHeadersJson NVARCHAR(4000) NULL,
  ResponseBody NVARCHAR(MAX) NULL,
  ResourceId VARCHAR(64) NULL,
  LockedUntil DATETIME2(3) NOT NULL,
  ExpiresAt DATETIME2(3) NOT NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_IdempotencyKeys_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_IdempotencyKeys_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_IdempotencyKeys PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT UQ_IdempotencyKeys_UserId_Scope_KeyValue UNIQUE (UserId, Scope, KeyValue),
  CONSTRAINT FK_IdempotencyKeys_Users FOREIGN KEY (UserId) REFERENCES orc.Users (Id),
  CONSTRAINT CK_IdempotencyKeys_Status CHECK (Status IN ('in_progress','completed')),
  CONSTRAINT CK_IdempotencyKeys_Completed CHECK (Status = 'in_progress' OR (ResponseStatus IS NOT NULL AND ResponseBody IS NOT NULL)),
  CONSTRAINT CK_IdempotencyKeys_Headers CHECK (ResponseHeadersJson IS NULL OR ISJSON(ResponseHeadersJson, OBJECT) = 1)
);
CREATE INDEX IX_IdempotencyKeys_ExpiresAt ON orc.IdempotencyKeys (ExpiresAt);
GO

CREATE TABLE orc.WorkerNodes (
  Id NVARCHAR(128) NOT NULL,                            -- WORKER_ID
  Hostname NVARCHAR(255) NOT NULL,
  Pid INT NOT NULL,
  AppVersion VARCHAR(32) NOT NULL,
  CliVersion VARCHAR(32) NULL,
  McpVersion VARCHAR(32) NULL,
  Concurrency INT NOT NULL,
  ActiveJobs INT NOT NULL CONSTRAINT DF_WorkerNodes_ActiveJobs DEFAULT 0,
  Status VARCHAR(10) NOT NULL,
  DiskFreeBytes BIGINT NULL,
  StartedAt DATETIME2(3) NOT NULL,
  LastHeartbeatAt DATETIME2(3) NOT NULL CONSTRAINT DF_WorkerNodes_LastHeartbeatAt DEFAULT SYSUTCDATETIME(),
  StoppedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_WorkerNodes_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_WorkerNodes_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_WorkerNodes PRIMARY KEY CLUSTERED (Id),
  CONSTRAINT CK_WorkerNodes_Status CHECK (Status IN ('starting','ready','draining','offline')),
  CONSTRAINT CK_WorkerNodes_Counts CHECK (Concurrency >= 1 AND ActiveJobs >= 0)
);
CREATE INDEX IX_WorkerNodes_Status ON orc.WorkerNodes (Status, LastHeartbeatAt);
GO
