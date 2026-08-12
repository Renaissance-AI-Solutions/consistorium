import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContinuityStore, CreateHandoffInputSchema, UpsertTaskInputSchema } from "../core/continuity.js";
import { observeRepositoryState, listWorktrees } from "../providers/git.js";
import type { ResolvedConfig } from "../core/types.js";
import { cleanup, commitFile, createGitRepo, git, mkdtemp } from "./helpers.js";

const disposables: string[] = [];

function configFor(repo: string, stateDir: string): ResolvedConfig {
  return {
    version: 1,
    projects: [{ name: "proj", canonicalPath: repo, originalPath: repo, contextPatterns: [] }],
    sessionArtifacts: { patterns: [] },
    search: { maxResults: 50, maxFileSizeBytes: 512 * 1024 },
    limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 50, maxWorktrees: 50 },
    configPath: path.join(stateDir, "config.yaml"),
    observedAt: new Date().toISOString(),
  };
}

afterEach(async () => {
  while (disposables.length) await cleanup(disposables.pop()!);
});

describe("durable continuity", () => {
  it("derives default state outside a configured repository when config is at the project root", async () => {
    const repo = await createGitRepo();
    disposables.push(repo);
    const config = configFor(repo, repo);
    const store = new ContinuityStore({ ...config, configPath: path.join(repo, "context-bridge.yaml") });
    expect(store.stateDir === repo || store.stateDir.startsWith(`${repo}${path.sep}`)).toBe(false);
    expect(path.parse(store.stateDir).root).not.toBe(store.stateDir);
  });

  it("uses an unprivileged portable location for a filesystem-root config path", async () => {
    const repo = await createGitRepo();
    disposables.push(repo);
    const config = configFor(repo, repo);
    const filesystemRoot = path.parse(repo).root;
    const store = new ContinuityStore({ ...config, configPath: path.join(filesystemRoot, "context-bridge.yaml") });
    expect(store.stateDir === repo || store.stateDir.startsWith(`${repo}${path.sep}`)).toBe(false);
    expect(store.stateDir).not.toBe(filesystemRoot);
  });

  it("keeps an existing legacy sibling state directory visible after upgrade", async () => {
    const container = await mkdtemp("cb-upgrade-");
    const repo = path.join(container, "project");
    const legacyState = path.join(container, ".context-bridge-state");
    disposables.push(container);
    await fs.promises.mkdir(repo);
    await fs.promises.mkdir(legacyState);
    const config = configFor(repo, repo);
    const store = new ContinuityStore({ ...config, configPath: path.join(repo, "context-bridge.yaml") });
    expect(store.stateDir).toBe(legacyState);
  });

  it("persists bounded tasks atomically and keeps lists compact", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-state-");
    disposables.push(repo, stateDir);
    await commitFile(repo, "README.md", "hello", "initial");
    const store = new ContinuityStore(configFor(repo, stateDir), { stateDir });

    const task = await store.upsertTask({
      project: "proj",
      taskId: "handoff-1",
      title: "Carry the fix",
      objective: "A detailed objective that belongs only in the detail response",
      state: "in_progress",
      constraints: ["Do not reset inherited work"],
      nextActions: ["Run direct verification"],
      provenance: { name: "agent-a", harness: "hermes", sessionId: "session-a" },
    });
    expect(task.createdAt).toBe(task.updatedAt);

    const listed = await store.listTasks({ limit: 20 });
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).not.toHaveProperty("objective");
    expect(listed.tasks[0]?.taskId).toBe("handoff-1");

    const detail = await store.getTask({ project: "proj", taskId: "handoff-1" });
    expect(detail.objective).toContain("detailed objective");
    expect(detail.repositoryState.observed.availability).toBe("available");

    const stateStat = await fs.promises.stat(stateDir);
    expect(stateStat.mode & 0o777).toBe(0o700);
    const storedFiles = await fs.promises.readdir(path.join(stateDir, "tasks"));
    expect(storedFiles).toHaveLength(1);
    const fileStat = await fs.promises.stat(path.join(stateDir, "tasks", storedFiles[0]!));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect((await fs.promises.readdir(path.join(stateDir, "tasks"))).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("rejects unsafe identifiers and oversized bounded fields", () => {
    expect(() => UpsertTaskInputSchema.parse({
      project: "proj",
      taskId: "../escape",
      title: "title",
      objective: "objective",
      state: "open",
    })).toThrow();
    expect(() => CreateHandoffInputSchema.parse({
      project: "proj",
      taskId: "task",
      status: "blocked",
      summary: "x".repeat(4001),
    })).toThrow();
  });

  it("rejects stale task updates and accepts a matching expected version", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-state-");
    disposables.push(repo, stateDir);
    const store = new ContinuityStore(configFor(repo, stateDir), { stateDir });
    const created = await store.upsertTask({
      project: "proj",
      taskId: "versioned-task",
      title: "Initial",
      objective: "Keep the versioned task safe",
      state: "open",
    });

    await expect(store.upsertTask({
      project: "proj",
      taskId: "versioned-task",
      title: "Stale overwrite",
      objective: "Must not replace the current record",
      state: "blocked",
      expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const updated = await store.upsertTask({
      project: "proj",
      taskId: "versioned-task",
      title: "Current update",
      objective: "Use the version returned by the prior read",
      state: "in_progress",
      expectedUpdatedAt: created.updatedAt,
    });
    expect(updated.title).toBe("Current update");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it("serializes duplicate handoff creation and preserves the winning record", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-state-");
    disposables.push(repo, stateDir);
    const store = new ContinuityStore(configFor(repo, stateDir), { stateDir });
    const otherStore = new ContinuityStore(configFor(repo, stateDir), { stateDir });
    const makeInput = (summary: string) => ({
      project: "proj" as const,
      taskId: "versioned-task" as const,
      handoffId: "duplicate-handoff" as const,
      status: "ready_for_review" as const,
      summary,
    });

    const results = await Promise.allSettled([
      store.createHandoff(makeInput("first writer")),
      otherStore.createHandoff(makeInput("second writer")),
    ]);
    const successes = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.createHandoff>>> => result.status === "fulfilled");
    const conflicts = results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "CONFLICT");
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const stored = await store.getHandoff({ project: "proj", handoffId: "duplicate-handoff" });
    expect(stored.summary).toBe(successes[0]!.value.summary);
  });

  it("captures canonical Git state and explicit mismatches, then refreshes staleness", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-state-");
    disposables.push(repo, stateDir);
    const firstHead = await commitFile(repo, "README.md", "hello", "initial");
    const store = new ContinuityStore(configFor(repo, stateDir), { stateDir });

    const handoff = await store.createHandoff({
      project: "proj",
      taskId: "handoff-1",
      handoffId: "handoff-a",
      worktreePath: repo,
      status: "ready_for_review",
      summary: "Implementation is ready",
      validation: [{ name: "unit", status: "passed" }],
      assertedRepositoryState: { branch: "wrong-branch", head: "0".repeat(40), isDirty: false },
    });
    expect(handoff.repositoryState.canonical.availability).toBe("available");
    expect(handoff.repositoryState.canonical.head).toBe(firstHead);
    expect(handoff.repositoryState.mismatches.map((item) => item.field)).toEqual(expect.arrayContaining(["branch", "head"]));

    await commitFile(repo, "next.txt", "changed", "state changed");
    const detail = await store.getHandoff({ project: "proj", handoffId: "handoff-a" });
    expect(detail.repositoryState.refreshed.head).not.toBe(firstHead);
    expect(detail.repositoryState.staleness.changedSinceCanonical).toBe(true);
    expect(detail.repositoryState.refreshedMismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "branch", asserted: "wrong-branch" }),
    ]));
  });

  it("does not collapse non-Git or unavailable observation into clean state", async () => {
    const nonGit = await mkdtemp("cb-non-git-");
    disposables.push(nonGit);
    const observation = await observeRepositoryState(nonGit);
    expect(observation.availability).toBe("not_git");
    expect(observation.isDirty).toBeNull();
    expect(observation.head).toBeNull();
    expect(observation.error).toBeTruthy();
  });

  it("canonicalizes an existing symlink before enforcing the observation root", async () => {
    const repo = await createGitRepo();
    const outside = await createGitRepo(await mkdtemp("cb-observe-outside-"));
    disposables.push(repo, outside);
    await commitFile(outside, "README.md", "outside", "initial");
    const link = path.join(repo, "linked-outside");
    await fs.promises.symlink(outside, link);

    const observation = await observeRepositoryState(link, repo);
    expect(observation.availability).toBe("unavailable");
    expect(observation.isDirty).toBeNull();
    expect(observation.error).toMatch(/outside/);
  });

  it("lists external linked worktree metadata without inspecting its state", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-state-");
    const external = await mkdtemp("cb-external-wt-");
    disposables.push(repo, stateDir, external);
    await commitFile(repo, "README.md", "hello", "initial");
    await git(repo, ["branch", "external-branch"]);
    await fs.promises.rm(external, { recursive: true, force: true });
    await git(repo, ["worktree", "add", external, "external-branch"]);
    await fs.promises.writeFile(path.join(external, "unreported.txt"), "outside root");

    const worktrees = await listWorktrees(repo, repo, 50);
    const externalCanonical = await fs.promises.realpath(external);
    const externalInfo = worktrees.find((item) => item.canonicalPath === externalCanonical);
    expect(externalInfo).toBeTruthy();
    expect(externalInfo?.inspection).toBe("limited");
    expect(externalInfo?.isDirty).toBeNull();
    expect(externalInfo?.unavailableReason).toMatch(/outside/);
  });
});
