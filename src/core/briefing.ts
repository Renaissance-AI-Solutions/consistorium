/**
 * Grounded project briefing — assembles live observation and agent-recorded
 * continuity into one high-density response. Nothing here is generated prose.
 */
import type {
  BriefingAction,
  BriefingExcerpt,
  BriefingSource,
  ContextDocContent,
  ProjectBriefing,
} from "./types.js";
import { ContextService } from "./context.js";
import { ContinuityStore } from "./continuity.js";

const EXCERPT_BYTES = 1_500;
const MAX_DOCS = 4;
const MAX_HANDOFF_DETAILS = 3;

const PURPOSE_PATHS = ["readme.md", "00-start-here.md"];
const ARCH_PATHS = ["design.md", "docs/architecture.md", "architecture.md", "docs/design.md", "01-architecture-and-specs.md"];
const PLAN_PATHS = ["todo.md", "roadmap.md", "idea.md", "03-execution-roadmap.md"];

// On-disk casings tried when loading, ordered by role so the cap cannot
// starve the purpose/architecture slots. Classification still uses the
// lowercase *_PATHS lists above.
const PURPOSE_CANDIDATES = ["README.md", "00-START-HERE.md"];
const ARCH_CANDIDATES = [
  "DESIGN.md",
  "docs/architecture.md",
  "docs/ARCHITECTURE.md",
  "docs/design.md",
  "architecture.md",
  "01-architecture-and-specs.md",
];
const PLAN_CANDIDATES = ["TODO.md", "ROADMAP.md", "IDEA.md", "03-execution-roadmap.md"];

function now(): string {
  return new Date().toISOString();
}

function posixLower(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function firstParagraph(text: string): string {
  const withoutHeading = text.replace(/^#[^\n]*\n+/, "");
  const parts = withoutHeading.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return (parts[0] ?? withoutHeading.trim()).slice(0, EXCERPT_BYTES);
}

function toExcerpt(
  doc: ContextDocContent,
  role: BriefingExcerpt["role"]
): BriefingExcerpt {
  const excerpt = role === "purpose" ? firstParagraph(doc.content) : doc.content.slice(0, EXCERPT_BYTES);
  return {
    path: doc.path,
    role,
    excerpt,
    truncated: doc.truncated || doc.content.length > EXCERPT_BYTES,
    modifiedAt: doc.modifiedAt,
  };
}

function pickDoc(
  docs: ContextDocContent[],
  candidates: string[]
): ContextDocContent | undefined {
  return docs.find((doc) => candidates.includes(posixLower(doc.path)));
}

function sourceFromDoc(doc: BriefingExcerpt): BriefingSource {
  return {
    kind: "document",
    claimType: "live_observation",
    observedAt: doc.modifiedAt,
    label: doc.path,
    path: doc.path,
  };
}

export interface BriefingOptions {
  recentLimit?: number;
  includeDocuments?: boolean;
}

export async function buildProjectBriefing(
  service: ContextService,
  continuity: ContinuityStore,
  projectName: string,
  opts: BriefingOptions = {}
): Promise<ProjectBriefing> {
  const observedAt = now();
  const recentLimit = Math.min(Math.max(opts.recentLimit ?? 8, 1), 20);
  const includeDocuments = opts.includeDocuments !== false;

  const snapshot = await service.projectSnapshot(projectName, {
    recentLimit,
    includeSessions: false,
    includeDocuments: false,
  });

  const gitSource: BriefingSource = {
    kind: "git",
    claimType: "live_observation",
    observedAt: snapshot.provenance.observedAt,
    label: "live git observation",
    commit: snapshot.git?.headCommit ?? undefined,
    path: snapshot.project.canonicalPath,
  };

  const sources: BriefingSource[] = [gitSource];
  const documents: BriefingExcerpt[] = [];
  let purpose: BriefingExcerpt | undefined;
  let architecture: BriefingExcerpt | undefined;

  if (includeDocuments) {
    const tried = new Set<string>();
    const loaded: ContextDocContent[] = [];

    const tryLoad = async (rel: string): Promise<ContextDocContent | undefined> => {
      const key = posixLower(rel);
      if (tried.has(key)) return undefined;
      tried.add(key);
      try {
        return await service.readContextDocument(projectName, rel, { maxBytes: EXCERPT_BYTES + 256 });
      } catch {
        // Missing or not allowlisted: omit rather than invent.
        return undefined;
      }
    };

    // Fill one slot per hero role first. Loading a flat list instead let plan
    // documents spend the MAX_DOCS cap before the architecture doc was tried.
    for (const group of [PURPOSE_CANDIDATES, ARCH_CANDIDATES]) {
      for (const rel of group) {
        const doc = await tryLoad(rel);
        if (doc) {
          loaded.push(doc);
          break;
        }
      }
    }

    // Remaining slots go to plan documents.
    for (const rel of PLAN_CANDIDATES) {
      if (loaded.length >= MAX_DOCS) break;
      const doc = await tryLoad(rel);
      if (doc) loaded.push(doc);
    }

    const purposeDoc = pickDoc(loaded, PURPOSE_PATHS);
    const archDoc = pickDoc(loaded, ARCH_PATHS);
    if (purposeDoc) {
      purpose = toExcerpt(purposeDoc, "purpose");
      documents.push(purpose);
      sources.push(sourceFromDoc(purpose));
    }
    if (archDoc) {
      architecture = toExcerpt(archDoc, "architecture");
      documents.push(architecture);
      sources.push(sourceFromDoc(architecture));
    }
    for (const doc of loaded) {
      const key = posixLower(doc.path);
      if (PURPOSE_PATHS.includes(key) || ARCH_PATHS.includes(key)) continue;
      const excerpt = toExcerpt(doc, PLAN_PATHS.includes(key) ? "plan" : "other");
      documents.push(excerpt);
      sources.push(sourceFromDoc(excerpt));
    }
  }

  const listedTasks = await continuity.listTasks({ project: projectName, limit: 20 });
  const openTasks = listedTasks.tasks.filter((task) => task.state !== "complete" && task.state !== "cancelled");
  const listedHandoffs = await continuity.listHandoffs({ project: projectName, limit: 10 });

  const latestHandoffs: ProjectBriefing["continuity"]["latestHandoffs"] = [];
  const blockers: BriefingAction[] = [];
  const decisions: BriefingAction[] = [];
  const nextActions: BriefingAction[] = [];

  for (const compact of listedHandoffs.handoffs.slice(0, MAX_HANDOFF_DETAILS)) {
    const detail = await continuity.getHandoff({ project: projectName, handoffId: compact.handoffId });
    const handoffSource: BriefingSource = {
      kind: "handoff",
      claimType: "agent_record",
      observedAt: detail.createdAt,
      label: `handoff ${detail.handoffId}`,
      handoffId: detail.handoffId,
      taskId: detail.taskId,
      agent: detail.agent.name ?? detail.agent.harness,
      commit: detail.repositoryState.canonical.head ?? undefined,
    };
    sources.push(handoffSource);
    latestHandoffs.push({
      handoffId: detail.handoffId,
      taskId: detail.taskId,
      status: detail.status,
      summary: detail.summary,
      agent: detail.agent,
      createdAt: detail.createdAt,
      blockers: detail.blockers,
      decisions: detail.decisions,
      nextActions: detail.nextActions,
      stale: detail.repositoryState.staleness.changedSinceCanonical,
    });
    for (const text of detail.blockers) blockers.push({ text, source: handoffSource });
    for (const text of detail.decisions) decisions.push({ text, source: handoffSource });
    for (const text of detail.nextActions) nextActions.push({ text, source: handoffSource });
  }

  for (const task of openTasks) {
    const taskSource: BriefingSource = {
      kind: "task",
      claimType: "agent_record",
      observedAt: task.updatedAt,
      label: `task ${task.taskId}`,
      taskId: task.taskId,
      agent: task.provenance.name ?? task.provenance.harness,
    };
    sources.push(taskSource);
    if (task.state === "blocked") {
      blockers.push({ text: `${task.title} is blocked`, source: taskSource });
    }
    for (const text of task.nextActions) nextActions.push({ text, source: taskSource });
  }

  const dirtyWorktrees = snapshot.worktrees
    .filter((wt) => wt.isDirty)
    .map((wt) => ({ path: wt.path, branch: wt.branch, isDirty: wt.isDirty }));

  let recommendedItems: BriefingAction[] = [];
  let rationale: string;
  const latest = latestHandoffs[0];
  const blockedTask = openTasks.find((task) => task.state === "blocked");
  if (blockedTask) {
    const matching = blockers.filter((item) => item.source.taskId === blockedTask.taskId || item.source.kind === "handoff");
    recommendedItems = matching.length ? matching.slice(0, 5) : [{
      text: `${blockedTask.title} is blocked`,
      source: {
        kind: "task",
        claimType: "agent_record",
        observedAt: blockedTask.updatedAt,
        label: `task ${blockedTask.taskId}`,
        taskId: blockedTask.taskId,
      },
    }];
    rationale = "A recorded task is blocked. Resolve that before starting new work.";
  } else if (latest && latest.blockers.length > 0) {
    recommendedItems = blockers.filter((item) => item.source.handoffId === latest.handoffId).slice(0, 5);
    rationale = `Latest handoff ${latest.handoffId} recorded blockers. These are agent claims, not live git facts.`;
  } else if (latest && latest.nextActions.length > 0) {
    recommendedItems = nextActions.filter((item) => item.source.handoffId === latest.handoffId).slice(0, 5);
    rationale = `Continue from next actions recorded in the latest handoff ${latest.handoffId}.`;
  } else if (openTasks[0] && openTasks[0].nextActions.length > 0) {
    recommendedItems = nextActions.filter((item) => item.source.taskId === openTasks[0]!.taskId).slice(0, 5);
    rationale = `No recent handoff next-actions; use next actions on open task ${openTasks[0].taskId}.`;
  } else if (snapshot.git?.isDirty) {
    recommendedItems = [{
      text: "Working tree is dirty; inspect uncommitted changes before planning new work.",
      source: gitSource,
    }];
    rationale = "No unfinished task/handoff next-actions were recorded. Live git shows uncommitted work.";
  } else if (openTasks.length === 0 && latestHandoffs.length === 0) {
    recommendedItems = [{
      text: "No tasks or handoffs are recorded yet. Orient from live git and allowlisted documents, then create a task if work should continue across agents.",
      source: gitSource,
    }];
    rationale = "This project has live repository state but no continuity records.";
  } else {
    recommendedItems = [{
      text: openTasks[0] ? `Review open task ${openTasks[0].taskId}: ${openTasks[0].title}` : "Review latest handoff and live git before deciding.",
      source: openTasks[0]
        ? {
            kind: "task",
            claimType: "agent_record",
            observedAt: openTasks[0].updatedAt,
            label: `task ${openTasks[0].taskId}`,
            taskId: openTasks[0].taskId,
          }
        : gitSource,
    }];
    rationale = "Continuity records exist but do not list a specific next action.";
  }

  const caveats = [
    "Live git fields are observed from the repository at provenance.observedAt.",
    "Task and handoff fields are agent-recorded claims. Verify them against live git before acting.",
    "Document excerpts come only from allowlisted context files; missing files are omitted, not invented.",
  ];
  if (latest?.stale) {
    caveats.push(`Latest handoff ${latest.handoffId} is stale relative to the current branch/HEAD/dirty state.`);
  }

  return {
    project: snapshot.project,
    purpose,
    architecture,
    live: {
      availability: snapshot.project.gitAvailability ?? (snapshot.project.isGitRepo ? "available" : "not_git"),
      branch: snapshot.git?.branch ?? null,
      head: snapshot.git?.headCommit ?? null,
      headShort: snapshot.git?.headCommitShort ?? null,
      isDirty: snapshot.git?.isDirty ?? null,
      isDetached: snapshot.git?.isDetached ?? false,
      error: snapshot.git?.error,
      worktreeCount: snapshot.worktrees.length,
      dirtyWorktrees,
      recentCommits: snapshot.recentChanges?.commits ?? snapshot.git?.recentCommits ?? [],
    },
    documents,
    continuity: {
      openTasks: openTasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        nextActions: task.nextActions,
        updatedAt: task.updatedAt,
        provenance: task.provenance,
      })),
      latestHandoffs,
      blockers,
      decisions,
      nextActions,
      },
    recommendedFocus: { items: recommendedItems, rationale },
    caveats,
    provenance: {
      observedAt,
      projectName: snapshot.project.name,
      projectPath: snapshot.project.canonicalPath,
      sources,
    },
  };
}
