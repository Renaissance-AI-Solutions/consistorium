import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup } from "./helpers.js";
import { SecurityPolicy } from "../core/security.js";
import { GenericSessionAdapter } from "../adapters/session.js";
import type { ResolvedConfig } from "../core/types.js";

describe("session adapter (generic)", () => {
  let projectRoot: string;
  let config: ResolvedConfig;
  let policy: SecurityPolicy;

  beforeEach(async () => {
    projectRoot = await mkdtemp();
    const real = await fs.promises.realpath(projectRoot);
    // Create some session artifacts
    await fs.promises.mkdir(path.join(real, "reports"), { recursive: true });
    await fs.promises.writeFile(
      path.join(real, "reports", "session-1.json"),
      JSON.stringify({ harness: "codex", model: "gpt-5", state: "completed", title: "fix auth", startedAt: "2026-01-01T00:00:00Z" })
    );
    await fs.promises.writeFile(path.join(real, "reports", "session-2.md"), "# My session\nThis is a test session about refactoring.");

    // Denied file should be ignored even if pattern matches
    await fs.promises.writeFile(path.join(real, "reports", "my-secret-session.json"), JSON.stringify({ secret: true }));

    config = {
      version: 1,
      projects: [{ name: "proj", canonicalPath: real, originalPath: real, contextPatterns: [] }],
      sessionArtifacts: { patterns: ["reports/**/*"] },
      search: { maxResults: 100, maxFileSizeBytes: 512 * 1024 },
      limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 100 },
      configPath: path.join(real, "config.yaml"),
      observedAt: new Date().toISOString(),
    };
    policy = new SecurityPolicy([real]);
  });

  afterEach(async () => {
    await cleanup(projectRoot);
  });

  it("discovers generic session artifacts", async () => {
    const adapter = new GenericSessionAdapter();
    const sessions = await adapter.listSessions(config, policy);
    // Should find session-1.json and session-2.md, but not my-secret-session.json
    expect(sessions.length).toBe(2);
    const ids = sessions.map((s) => s.id);
    expect(ids.some((id) => id.includes("session-1.json"))).toBe(true);
    expect(ids.some((id) => id.includes("session-2.md"))).toBe(true);
    expect(ids.some((id) => id.includes("secret"))).toBe(false);
  });

  it("normalizes harness/model/state", async () => {
    const adapter = new GenericSessionAdapter();
    const sessions = await adapter.listSessions(config, policy);
    const jsonSess = sessions.find((s) => s.sourcePath.endsWith("session-1.json"));
    expect(jsonSess).toBeDefined();
    expect(jsonSess!.harness).toBe("codex");
    expect(jsonSess!.model).toBe("gpt-5");
    expect(jsonSess!.state).toBe("completed");
    expect(jsonSess!.title).toBe("fix auth");
  });

  it("redacts secrets in preview", async () => {
    const real = config.projects[0]!.canonicalPath;
    // Avoid filename containing "secret" (it is denylisted), use "with-keys" instead
    await fs.promises.writeFile(
      path.join(real, "reports", "with-keys.json"),
      JSON.stringify({ summary: "API key is sk-12345678901234567890 and token ghp_abcdef12345678901234567890" })
    );
    const adapter = new GenericSessionAdapter();
    const sessions = await adapter.listSessions(config, policy);
    const s = sessions.find((ss) => ss.sourcePath.endsWith("with-keys.json"));
    expect(s).toBeDefined();
    expect(s!.summaryPreview).not.toContain("sk-1234");
    expect(s!.summaryPreview).toContain("[REDACTED]");
  });

  it("returns snapshot with bounded rawPreview", async () => {
    const adapter = new GenericSessionAdapter();
    const sessions = await adapter.listSessions(config, policy);
    const id = sessions[0]!.id;
    const snap = await adapter.getSessionSnapshot(config, policy, id);
    expect(snap).not.toBeNull();
    expect(snap!.rawPreview).toBeTruthy();
    expect(snap!.id).toBe(id);
  });

  it("returns null for unknown session id", async () => {
    const adapter = new GenericSessionAdapter();
    expect(await adapter.getSessionSnapshot(config, policy, "not-exist")).toBeNull();
  });

  it("denies symlink escapes", async () => {
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "evil.json"), JSON.stringify({ title: "evil" }));
      const link = path.join(config.projects[0]!.canonicalPath, "reports", "link-out");
      await fs.promises.symlink(outside, link);
      const adapter = new GenericSessionAdapter();
      const sessions = await adapter.listSessions(config, policy);
      // Should not include evil.json via symlink
      expect(sessions.some((s) => s.title === "evil")).toBe(false);
    } finally {
      await cleanup(outside);
    }
  });

  it("handles absolute pattern still policy-checked", async () => {
    const outside = await mkdtemp();
    try {
      const evilPath = path.join(outside, "outside-session.json");
      await fs.promises.writeFile(evilPath, JSON.stringify({ title: "outside" }));
      const cfg2: ResolvedConfig = {
        ...config,
        sessionArtifacts: { patterns: [evilPath] },
      };
      // Policy only allows projectRoot, so outside should be denied
      const pol2 = new SecurityPolicy([config.projects[0]!.canonicalPath]);
      const adapter = new GenericSessionAdapter();
      const sessions = await adapter.listSessions(cfg2, pol2);
      expect(sessions.some((s) => s.title === "outside")).toBe(false);
    } finally {
      await cleanup(outside);
    }
  });
});
