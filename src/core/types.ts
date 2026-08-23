/**
 * Normalized data models for Consistorium.
 * All timestamps are ISO 8601 strings.
 * All counts/sizes are bounded.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RawConfig {
  version?: number;
  projects: RawProjectConfig[];
  sessionArtifacts?: SessionArtifactsConfig;
  search?: SearchConfig;
  limits?: LimitsConfig;
}

// Project names, task IDs, and handoff IDs share one portable identifier
// contract. Keeping the pattern here prevents config and continuity from
// accepting different names for the same logical project.
export const SAFE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const SAFE_ID_REGEX = new RegExp(SAFE_ID_PATTERN);
export const SAFE_ID_MESSAGE = "must be a safe identifier (letters, numbers, ., _, -)";

export interface RawProjectConfig {
  name: string;
  path: string;
  context?: string[]; // glob patterns, relative to project root
}

export interface SessionArtifactsConfig {
  // Generic session artifact adapter: explicit glob patterns relative to project root
  // or absolute paths that must still be within allowed roots.
  patterns?: string[];
  // Deprecated alias
  // paths?: string[];
}

export interface SearchConfig {
  maxResults?: number;
  maxFileSizeBytes?: number;
}

export interface LimitsConfig {
  maxFileSizeBytes?: number; // for read_context_document
  maxDiffBytes?: number;
  maxSearchResults?: number;
  maxWorktrees?: number;
}

export interface ResolvedConfig {
  version: number;
  projects: ResolvedProject[];
  sessionArtifacts: { patterns: string[] };
  search: { maxResults: number; maxFileSizeBytes: number };
  limits: { maxFileSizeBytes: number; maxDiffBytes: number; maxSearchResults: number; maxWorktrees?: number };
  configPath: string; // canonical path of the config file loaded
  observedAt: string;
}

export interface ResolvedProject {
  name: string;
  canonicalPath: string; // realpath
  originalPath: string;
  contextPatterns: string[]; // as configured, relative
}

// ---------------------------------------------------------------------------
// Security / policy
// ---------------------------------------------------------------------------

export interface PolicyViolation {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Git / Project models
// ---------------------------------------------------------------------------

export interface ProjectSnapshot {
  project: ProjectInfo;
  git?: GitRepoState;
  worktrees: WorktreeInfo[];
  contextDocuments: ContextDocSummary[];
  recentChanges?: RecentChanges;
  sessions: SessionSummary[];
  provenance: Provenance;
}

export interface ProjectInfo {
  name: string;
  canonicalPath: string;
  isGitRepo: boolean;
  gitAvailability?: "available" | "not_git" | "unavailable";
}

export interface GitRepoState {
  availability?: "available" | "not_git" | "unavailable";
  error?: string;
  branch: string | null; // null for detached HEAD
  headCommit: string | null; // full sha or null if no commits
  headCommitShort: string | null;
  isDetached: boolean;
  isDirty: boolean | null;
  ahead?: number | null;
  behind?: number | null;
  upstream?: string | null;
  recentCommits: CommitSummary[];
}

export interface WorktreeInfo {
  path: string;
  canonicalPath: string;
  branch: string | null;
  headCommit: string | null;
  headCommitShort: string | null;
  isDetached: boolean;
  isDirty: boolean | null;
  isMain: boolean;
  isMissing: boolean; // path does not exist on disk
  stagedChanges: FileChange[];
  unstagedChanges: FileChange[];
  untrackedFiles: string[]; // capped
  untrackedCount: number;
  inspection?: "available" | "limited" | "unavailable";
  unavailableReason?: string;
  ahead?: number | null;
  behind?: number | null;
  upstream?: string | null;
  provenance: Provenance;
}

export interface FileChange {
  path: string;
  status: string; // e.g. "M", "A", "D", "R", "C", "U"
  staged: boolean;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string; // ISO
  parents: string[];
}

export interface RecentChanges {
  commits: CommitSummary[];
  changedFiles: ChangedFileStat[];
  diffStat: string; // git diff --stat style, bounded
  mergeBase?: string | null;
}

export interface ChangedFileStat {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface CompareResult {
  base: string;
  target: string;
  mergeBase: string | null;
  aheadBy: number | null;
  behindBy: number | null;
  commits: CommitSummary[];
  diffStat: string;
  diff?: string | null; // bounded textual diff, if requested and allowed
  truncated: boolean;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Documents / Search
// ---------------------------------------------------------------------------

export interface ContextDocSummary {
  path: string; // relative to project root
  canonicalPath: string;
  sizeBytes: number;
  modifiedAt: string;
  matchesPattern: string;
}

export interface ContextDocContent {
  path: string;
  canonicalPath: string;
  sizeBytes: number;
  modifiedAt: string;
  content: string;
  truncated: boolean;
  provenance: Provenance;
}

export interface SearchResult {
  path: string; // relative
  canonicalPath: string;
  line: number;
  column: number;
  preview: string; // single line, truncated
  matchedText?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  truncated: boolean;
  totalMatches: number;
  searchedFiles: number;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  harness: string; // e.g. "generic", "codex", "claude-code"
  model?: string | null;
  project?: string | null; // project name if associated
  worktreePath?: string | null;
  state?: string | null;
  title?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  relatedFiles?: string[];
  summaryPreview?: string | null; // bounded, redacted
  sourcePath: string;
  provenance: Provenance;
}

export interface SessionSnapshot extends SessionSummary {
  rawPreview?: string | null; // bounded raw file preview if allowed
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface Provenance {
  observedAt: string;
  projectName?: string;
  projectPath?: string;
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Strategic briefing (grounded assembly — not a generated essay)
// ---------------------------------------------------------------------------

export type BriefingClaimType = "live_observation" | "agent_record";

export interface BriefingSource {
  kind: "git" | "document" | "task" | "handoff";
  claimType: BriefingClaimType;
  observedAt: string;
  label: string;
  path?: string;
  commit?: string;
  taskId?: string;
  handoffId?: string;
  agent?: string;
}

export interface BriefingExcerpt {
  path: string;
  role: "purpose" | "architecture" | "plan" | "other";
  excerpt: string;
  truncated: boolean;
  modifiedAt: string;
}

export interface BriefingAction {
  text: string;
  source: BriefingSource;
}

export interface ProjectBriefing {
  project: ProjectInfo;
  purpose?: BriefingExcerpt;
  architecture?: BriefingExcerpt;
  live: {
    availability: "available" | "not_git" | "unavailable";
    branch: string | null;
    head: string | null;
    headShort: string | null;
    isDirty: boolean | null;
    isDetached: boolean;
    error?: string;
    worktreeCount: number;
    dirtyWorktrees: Array<{ path: string; branch: string | null; isDirty: boolean | null }>;
    recentCommits: CommitSummary[];
  };
  documents: BriefingExcerpt[];
  continuity: {
    openTasks: Array<{
      taskId: string;
      title: string;
      state: string;
      nextActions: string[];
      updatedAt: string;
      provenance: { name?: string; harness?: string; model?: string; sessionId?: string };
    }>;
    latestHandoffs: Array<{
      handoffId: string;
      taskId: string;
      status: string;
      summary: string;
      agent: { name?: string; harness?: string; model?: string; sessionId?: string };
      createdAt: string;
      blockers: string[];
      decisions: string[];
      nextActions: string[];
      stale?: boolean | null;
    }>;
    blockers: BriefingAction[];
    decisions: BriefingAction[];
    nextActions: BriefingAction[];
  };
  recommendedFocus: {
    items: BriefingAction[];
    rationale: string;
  };
  caveats: string[];
  provenance: Provenance & { sources: BriefingSource[] };
}

// ---------------------------------------------------------------------------
// MCP tool wrappers
// ---------------------------------------------------------------------------

export interface BoundedOptions {
  maxBytes?: number;
  maxResults?: number;
}

export const DEFAULT_LIMITS = {
  maxFileSizeBytes: 256 * 1024, // 256 KiB
  maxDiffBytes: 128 * 1024, // 128 KiB
  maxSearchResults: 100,
  maxSearchFileSizeBytes: 512 * 1024,
  maxContextDocsPerProject: 200,
  // Directory entries discovery may examine before giving up on a subtree.
  maxContextScanEntries: 20_000,
  maxCommitsDefault: 20,
  maxCommitsMax: 100,
  maxUntrackedPreview: 50,
  maxWorktrees: 50,
} as const;
