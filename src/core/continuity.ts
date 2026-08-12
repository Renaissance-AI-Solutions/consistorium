/**
 * Durable, bounded task and handoff continuity.
 *
 * This module deliberately exposes only structured task/handoff operations.
 * It is not a generic file store, command runner, or agent orchestrator.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { SAFE_ID_MESSAGE, SAFE_ID_REGEX } from "./types.js";
import type { ResolvedConfig, ResolvedProject } from "./types.js";
import { observeRepositoryState, type RepositoryObservation } from "../providers/git.js";

const MAX_STRING = 4_000;
const MAX_SHORT_STRING = 500;
const MAX_ITEMS = 50;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_STORED_RECORDS = 500;
const recordLocks = new Map<string, Promise<void>>();
export const SafeIdSchema = z.string().regex(SAFE_ID_REGEX, SAFE_ID_MESSAGE);
const BoundedString = z.string().trim().min(1).max(MAX_STRING);
const ShortString = z.string().trim().min(1).max(MAX_SHORT_STRING);
const BoundedList = z.array(BoundedString).max(MAX_ITEMS);

const AgentSchema = z
  .object({
    name: ShortString.optional(),
    harness: ShortString.optional(),
    model: ShortString.optional(),
    sessionId: SafeIdSchema.optional(),
  })
  .strict();

const ValidationResultSchema = z
  .object({
    name: ShortString,
    status: z.enum(["passed", "failed", "skipped", "blocked", "unknown"]),
    details: BoundedString.optional(),
  })
  .strict();

const AssertedRepositoryStateSchema = z
  .object({
    branch: ShortString.optional(),
    head: z.string().trim().min(1).max(200).optional(),
    isDirty: z.boolean().optional(),
    worktreePath: BoundedString.optional(),
  })
  .strict();

export const UpsertTaskInputSchema = z
  .object({
    project: SafeIdSchema,
    taskId: SafeIdSchema,
    title: ShortString,
    objective: BoundedString,
    state: z.enum(["open", "in_progress", "blocked", "ready_for_review", "complete", "cancelled"]),
    expectedUpdatedAt: z.string().trim().min(1).max(64).optional(),
    constraints: BoundedList.default([]),
    nextActions: BoundedList.default([]),
    provenance: AgentSchema.optional(),
  })
  .strict();

export const ListTasksInputSchema = z
  .object({ project: SafeIdSchema.optional(), state: z.string().trim().min(1).max(64).optional(), limit: z.number().int().min(1).max(100).default(20) })
  .strict();

export const GetTaskInputSchema = z.object({ project: SafeIdSchema, taskId: SafeIdSchema }).strict();

export const CreateHandoffInputSchema = z
  .object({
    project: SafeIdSchema,
    taskId: SafeIdSchema,
    handoffId: SafeIdSchema.optional(),
    worktreePath: BoundedString.optional(),
    agent: AgentSchema.optional(),
    status: z.enum(["in_progress", "ready_for_review", "blocked", "complete", "cancelled"]),
    summary: BoundedString,
    findings: BoundedList.default([]),
    validation: z.array(ValidationResultSchema).max(MAX_ITEMS).default([]),
    decisions: BoundedList.default([]),
    blockers: BoundedList.default([]),
    nextActions: BoundedList.default([]),
    relevantFiles: z.array(ShortString).max(MAX_ITEMS).default([]),
    commits: z.array(z.string().trim().min(1).max(200)).max(MAX_ITEMS).default([]),
    assertedRepositoryState: AssertedRepositoryStateSchema.optional(),
  })
  .strict();

export const ListHandoffsInputSchema = z
  .object({ project: SafeIdSchema.optional(), taskId: SafeIdSchema.optional(), limit: z.number().int().min(1).max(100).default(20) })
  .strict();

export const GetHandoffInputSchema = z.object({ project: SafeIdSchema, handoffId: SafeIdSchema }).strict();

export type UpsertTaskInput = z.infer<typeof UpsertTaskInputSchema>;
export type CreateHandoffInput = z.infer<typeof CreateHandoffInputSchema>;
export type UpsertTaskRequest = z.input<typeof UpsertTaskInputSchema>;
export type CreateHandoffRequest = z.input<typeof CreateHandoffInputSchema>;

export interface RepositoryStateAssertion {
  branch?: string;
  head?: string;
  isDirty?: boolean;
  worktreePath?: string;
}

export interface RepositoryStateMismatch {
  field: keyof RepositoryStateAssertion;
  asserted: string | boolean | undefined;
  canonical: string | boolean | null | undefined;
}

export interface StoredTask {
  kind: "task";
  project: { name: string; canonicalPath: string };
  taskId: string;
  title: string;
  objective: string;
  state: UpsertTaskInput["state"];
  constraints: string[];
  nextActions: string[];
  createdAt: string;
  updatedAt: string;
  provenance: { name?: string; harness?: string; model?: string; sessionId?: string };
}

export interface StoredHandoff {
  kind: "handoff";
  handoffId: string;
  project: { name: string; canonicalPath: string };
  taskId: string;
  agent: { name?: string; harness?: string; model?: string; sessionId?: string };
  status: CreateHandoffInput["status"];
  summary: string;
  findings: string[];
  validation: Array<{ name: string; status: string; details?: string }>;
  decisions: string[];
  blockers: string[];
  nextActions: string[];
  relevantFiles: string[];
  commits: string[];
  repositoryState: {
    canonical: RepositoryObservation;
    assertion?: RepositoryStateAssertion;
    mismatches: RepositoryStateMismatch[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface ContinuityOptions {
  stateDir?: string;
}

export interface ContinuityError extends Error {
  code: string;
  details?: unknown;
}

function continuityError(code: string, message: string, details?: unknown): ContinuityError {
  return Object.assign(new Error(message), { code, details }) as ContinuityError;
}

function now(): string {
  return new Date().toISOString();
}

function nextTimestamp(previous?: string): string {
  const current = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  const timestamp = Number.isFinite(previousTime) ? Math.max(current, previousTime + 1) : current;
  return new Date(timestamp).toISOString();
}

function ensureBoundedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) {
    throw continuityError("BOUNDED", `record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return text;
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID_REGEX.test(value)) throw continuityError("INVALID_ID", `${label} ${SAFE_ID_MESSAGE}`);
  return value;
}

function keyFor(kind: string, project: string, id: string): string {
  return crypto.createHash("sha256").update(`${kind}\0${project}\0${id}`).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function defaultStateDir(configPath: string, projects: ResolvedProject[]): string {
  const configDir = path.dirname(configPath);
  const filesystemRoot = path.parse(path.resolve(configDir)).root;
  const candidates = [
    configDir === filesystemRoot ? undefined : path.join(configDir, "state"),
    process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "context-bridge") : undefined,
    path.join(os.homedir(), ".local", "state", "context-bridge"),
    path.join(os.homedir(), ".context-bridge-state"),
    path.join(os.tmpdir(), "context-bridge-state"),
  ];
  const candidate = candidates
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value))
    .find((value) => path.dirname(value) !== filesystemRoot && !projects.some((project) => isWithin(project.canonicalPath, value)));

  if (!candidate) {
    throw continuityError("INVALID_STATE_DIR", "could not derive a state directory outside all configured project roots; set CONTEXT_BRIDGE_STATE_DIR explicitly");
  }
  return candidate;
}

export function resolveStateDir(configPath: string, projects: ResolvedProject[], explicit = process.env.CONTEXT_BRIDGE_STATE_DIR): string {
  const raw = explicit?.trim();
  if (raw) {
    if (raw === "." || raw === ".." || raw.includes("\0")) throw continuityError("INVALID_STATE_DIR", "CONTEXT_BRIDGE_STATE_DIR is unsafe");
    const resolved = path.resolve(raw);
    if (resolved === path.parse(resolved).root || path.basename(resolved) === ".git") {
      throw continuityError("INVALID_STATE_DIR", "CONTEXT_BRIDGE_STATE_DIR must name a dedicated non-root directory");
    }
    return resolved;
  }
  return defaultStateDir(configPath, projects);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  const text = ensureBoundedJson(value);
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    const handle = await fs.promises.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${text}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.chmod(tempPath, 0o600);
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw continuityError("STATE_WRITE_FAILED", `could not atomically write ${path.basename(filePath)}`, error);
  }
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw continuityError("BOUNDED", "stored record exceeds the size limit");
    const text = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw continuityError("STATE_CORRUPT", `invalid JSON in ${path.basename(filePath)}`);
    throw error;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .slice(0, MAX_STORED_RECORDS)
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw continuityError("STATE_READ_FAILED", `could not list ${path.basename(dir)}`, error);
  }
}

function mismatchFor(assertion: RepositoryStateAssertion | undefined, canonical: RepositoryObservation): RepositoryStateMismatch[] {
  if (!assertion || canonical.availability !== "available") return [];
  const fields: Array<keyof RepositoryStateAssertion> = ["branch", "head", "isDirty", "worktreePath"];
  return fields
    .filter((field) => assertion[field] !== undefined)
    .filter((field) => {
      const canonicalValue = field === "head" ? canonical.head : field === "branch" ? canonical.branch : field === "isDirty" ? canonical.isDirty : canonical.worktreePath;
      return assertion[field] !== canonicalValue;
    })
    .map((field) => ({
      field,
      asserted: assertion[field],
      canonical: field === "head" ? canonical.head : field === "branch" ? canonical.branch : field === "isDirty" ? canonical.isDirty : canonical.worktreePath,
    }));
}

function compactTask(task: StoredTask) {
  return {
    taskId: task.taskId,
    project: task.project.name,
    title: task.title,
    state: task.state,
    nextActions: task.nextActions.slice(0, 5),
    updatedAt: task.updatedAt,
    provenance: task.provenance,
  };
}

function compactHandoff(handoff: StoredHandoff) {
  return {
    handoffId: handoff.handoffId,
    project: handoff.project.name,
    taskId: handoff.taskId,
    status: handoff.status,
    summary: handoff.summary.slice(0, MAX_SHORT_STRING),
    agent: handoff.agent,
    branch: handoff.repositoryState.canonical.branch,
    head: handoff.repositoryState.canonical.head,
    canonicalAvailability: handoff.repositoryState.canonical.availability,
    createdAt: handoff.createdAt,
  };
}

export class ContinuityStore {
  readonly stateDir: string;
  private readonly tasksDir: string;
  private readonly handoffsDir: string;

  constructor(private readonly config: ResolvedConfig, options: ContinuityOptions = {}) {
    this.stateDir = resolveStateDir(config.configPath, config.projects, options.stateDir);
    this.tasksDir = path.join(this.stateDir, "tasks");
    this.handoffsDir = path.join(this.stateDir, "handoffs");
  }

  private project(name: string): ResolvedProject {
    safeId(name, "project");
    const project = this.config.projects.find((candidate) => candidate.name === name);
    if (!project) throw continuityError("PROJECT_NOT_FOUND", `unknown configured project: ${name}`);
    return project;
  }

  private taskPath(project: string, taskId: string): string {
    safeId(project, "project");
    safeId(taskId, "taskId");
    return path.join(this.tasksDir, `${keyFor("task", project, taskId)}.json`);
  }

  private handoffPath(project: string, handoffId: string): string {
    safeId(project, "project");
    safeId(handoffId, "handoffId");
    return path.join(this.handoffsDir, `${keyFor("handoff", project, handoffId)}.json`);
  }

  private async withRecordLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${this.stateDir}\0${key}`;
    const previous = recordLocks.get(lockKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    recordLocks.set(lockKey, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (recordLocks.get(lockKey) === current) recordLocks.delete(lockKey);
    }
  }

  async upsertTask(input: UpsertTaskRequest): Promise<StoredTask> {
    const project = this.project(input.project);
    await this.ensureStorage();
    const filePath = this.taskPath(input.project, input.taskId);
    return this.withRecordLock(`task\0${input.project}\0${input.taskId}`, async () => {
      const existing = (await readJson(filePath)) as StoredTask | null;
      if (existing) {
        if (!input.expectedUpdatedAt) {
          throw continuityError(
            "CONFLICT",
            `task already exists; expectedUpdatedAt is required to update ${input.taskId}`,
            { kind: "task", project: input.project, taskId: input.taskId, expectedUpdatedAt: null, actualUpdatedAt: existing.updatedAt },
          );
        }
        if (input.expectedUpdatedAt !== existing.updatedAt) {
          throw continuityError(
            "CONFLICT",
            `task is stale; expectedUpdatedAt does not match ${input.taskId}`,
            { kind: "task", project: input.project, taskId: input.taskId, expectedUpdatedAt: input.expectedUpdatedAt, actualUpdatedAt: existing.updatedAt },
          );
        }
      } else if (input.expectedUpdatedAt) {
        throw continuityError(
          "CONFLICT",
          `task does not exist; remove expectedUpdatedAt to create ${input.taskId}`,
          { kind: "task", project: input.project, taskId: input.taskId, expectedUpdatedAt: input.expectedUpdatedAt, actualUpdatedAt: null },
        );
      }
      if (!existing && (await listJsonFiles(this.tasksDir)).length >= MAX_STORED_RECORDS) {
        throw continuityError("BOUNDED", `maximum of ${MAX_STORED_RECORDS} stored tasks reached`);
      }
      const timestamp = nextTimestamp(existing?.updatedAt);
      const task: StoredTask = {
        kind: "task",
        project: { name: project.name, canonicalPath: project.canonicalPath },
        taskId: input.taskId,
        title: input.title,
        objective: input.objective,
        state: input.state,
        constraints: input.constraints ?? [],
        nextActions: input.nextActions ?? [],
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        provenance: input.provenance ?? existing?.provenance ?? {},
      };
      await atomicWrite(filePath, task);
      return task;
    });
  }

  async listTasks(input: z.infer<typeof ListTasksInputSchema>) {
    if (input.project) safeId(input.project, "project");
    await this.ensureStorage();
    const files = await listJsonFiles(this.tasksDir);
    const tasks: StoredTask[] = [];
    for (const file of files) {
      const value = await readJson(file);
      if (!value) continue;
      const task = value as StoredTask;
      if (task.kind !== "task") continue;
      if (input.project && task.project.name !== input.project) continue;
      if (input.state && task.state !== input.state) continue;
      tasks.push(task);
    }
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { tasks: tasks.slice(0, input.limit).map(compactTask), total: tasks.length, stateDir: this.stateDir };
  }

  async getTask(input: z.infer<typeof GetTaskInputSchema>) {
    const project = this.project(input.project);
    const value = await readJson(this.taskPath(input.project, input.taskId));
    if (!value) throw continuityError("NOT_FOUND", `task not found: ${input.taskId}`);
    const task = value as StoredTask;
    const live = await this.observe(project);
    return { ...task, repositoryState: { observed: live } };
  }

  async createHandoff(input: CreateHandoffRequest): Promise<StoredHandoff> {
    const project = this.project(input.project);
    safeId(input.taskId, "taskId");
    await this.ensureStorage();
    const handoffId = input.handoffId ?? `h-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
    safeId(handoffId, "handoffId");
    const handoffPath = this.handoffPath(input.project, handoffId);
    return this.withRecordLock(`handoff\0${input.project}\0${handoffId}`, async () => {
      const existing = await readJson(handoffPath);
      if (existing) {
        throw continuityError(
          "CONFLICT",
          `handoffId already exists: ${handoffId}`,
          { kind: "handoff", project: input.project, handoffId, reason: "duplicate_handoff_id" },
        );
      }
      if ((await listJsonFiles(this.handoffsDir)).length >= MAX_STORED_RECORDS) {
        throw continuityError("BOUNDED", `maximum of ${MAX_STORED_RECORDS} stored handoffs reached`);
      }
      const canonical = await this.observe(project, input.worktreePath);
      const assertion = input.assertedRepositoryState;
      const timestamp = now();
      const handoff: StoredHandoff = {
        kind: "handoff",
        handoffId,
        project: { name: project.name, canonicalPath: project.canonicalPath },
        taskId: input.taskId,
        agent: input.agent ?? {},
        status: input.status,
        summary: input.summary,
        findings: input.findings ?? [],
        validation: input.validation ?? [],
        decisions: input.decisions ?? [],
        blockers: input.blockers ?? [],
        nextActions: input.nextActions ?? [],
        relevantFiles: input.relevantFiles ?? [],
        commits: input.commits ?? [],
        repositoryState: { canonical, assertion, mismatches: mismatchFor(assertion, canonical) },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await atomicWrite(handoffPath, handoff);
      return handoff;
    });
  }

  async listHandoffs(input: z.infer<typeof ListHandoffsInputSchema>) {
    if (input.project) safeId(input.project, "project");
    if (input.taskId) safeId(input.taskId, "taskId");
    await this.ensureStorage();
    const files = await listJsonFiles(this.handoffsDir);
    const handoffs: StoredHandoff[] = [];
    for (const file of files) {
      const value = await readJson(file);
      if (!value) continue;
      const handoff = value as StoredHandoff;
      if (handoff.kind !== "handoff") continue;
      if (input.project && handoff.project.name !== input.project) continue;
      if (input.taskId && handoff.taskId !== input.taskId) continue;
      handoffs.push(handoff);
    }
    handoffs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { handoffs: handoffs.slice(0, input.limit).map(compactHandoff), total: handoffs.length, stateDir: this.stateDir };
  }

  async getHandoff(input: z.infer<typeof GetHandoffInputSchema>) {
    const project = this.project(input.project);
    const value = await readJson(this.handoffPath(input.project, input.handoffId));
    if (!value) throw continuityError("NOT_FOUND", `handoff not found: ${input.handoffId}`);
    const handoff = value as StoredHandoff;
    const refreshed = await this.observe(project, handoff.repositoryState.canonical.worktreePath ?? undefined);
    const staleness = {
      canonicalObservedAt: handoff.repositoryState.canonical.observedAt,
      refreshedAt: refreshed.observedAt,
      changedSinceCanonical: refreshed.availability === "available" && handoff.repositoryState.canonical.availability === "available"
        ? refreshed.branch !== handoff.repositoryState.canonical.branch || refreshed.head !== handoff.repositoryState.canonical.head || refreshed.isDirty !== handoff.repositoryState.canonical.isDirty
        : null,
      unavailable: refreshed.availability !== "available",
      reason: refreshed.error,
    };
    return {
      ...handoff,
      repositoryState: {
        ...handoff.repositoryState,
        refreshed,
        staleness,
        refreshedMismatches: mismatchFor(handoff.repositoryState.assertion, refreshed),
      },
    };
  }

  private async observe(project: ResolvedProject, requestedPath?: string): Promise<RepositoryObservation> {
    const lexicalCandidate = requestedPath ? path.resolve(requestedPath) : project.canonicalPath;
    const candidate = await fs.promises.realpath(lexicalCandidate).catch(() => path.normalize(lexicalCandidate));
    const canonicalProject = await fs.promises.realpath(project.canonicalPath).catch(() => path.normalize(project.canonicalPath));
    const allowed = isWithin(canonicalProject, candidate);
    // A linked worktree outside the explicitly configured root is metadata-only.
    if (!allowed) {
      return {
        availability: "unavailable",
        observedAt: now(),
        repositoryPath: canonicalProject,
        worktreePath: candidate,
        branch: null,
        head: null,
        isDirty: null,
        error: "worktree is outside the explicitly configured project root",
      };
    }
    return observeRepositoryState(candidate, canonicalProject);
  }

  private async ensureStorage(): Promise<void> {
    await ensureDir(this.stateDir);
    await ensureDir(this.tasksDir);
    await ensureDir(this.handoffsDir);
  }
}
