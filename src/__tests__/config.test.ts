import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseConfigContent, resolveConfigSync } from "../core/config.js";

function fakePath(p: string): string {
  return path.resolve(p);
}

describe("config parse & validate", () => {
  it("parses minimal YAML", () => {
    const yaml = `
version: 1
projects:
  - name: proj-a
    path: /tmp/proj-a
    context: ["TODO.md"]
`;
    const raw = parseConfigContent(yaml, "config.yaml");
    expect(raw.projects).toHaveLength(1);
    expect(raw.projects[0]!.name).toBe("proj-a");
  });

  it("parses JSON", () => {
    const json = JSON.stringify({ version: 1, projects: [{ name: "p", path: "/tmp/p" }] });
    const raw = parseConfigContent(json, "config.json");
    expect(raw.projects[0]!.name).toBe("p");
  });

  it("rejects missing projects", () => {
    expect(() => parseConfigContent(`version: 1\n`, "config.yaml")).toThrow();
    expect(() => parseConfigContent(JSON.stringify({ version: 1 }), "config.json")).toThrow();
  });

  it("rejects empty project name", () => {
    const y = `projects:\n  - name: ""\n    path: /tmp/x\n`;
    expect(() => parseConfigContent(y, "config.yaml")).toThrow();
  });

  it("rejects project names with spaces using the continuity safe identifier contract", () => {
    const y = `projects:\n  - name: "project with spaces"\n    path: /tmp/x\n`;
    expect(() => parseConfigContent(y, "config.yaml")).toThrow(/safe identifier/);
  });

  it("rejects duplicate project names on resolve", () => {
    const raw = {
      version: 1,
      projects: [
        { name: "dup", path: "/tmp/a", context: [] as string[] },
        { name: "dup", path: "/tmp/b", context: [] as string[] },
      ],
      sessionArtifacts: { patterns: [] as string[] },
    };
    const p = fakePath("/tmp/fake-config.yaml");
    expect(() => resolveConfigSync(raw as any, p)).toThrow(/Duplicate project name/);
  });

  it("resolves relative project paths relative to config dir", () => {
    const cfgPath = "/tmp/my/config.yaml";
    const raw = {
      version: 1,
      projects: [{ name: "p", path: "./proj", context: [] as string[] }],
      sessionArtifacts: { patterns: [] as string[] },
    };
    const resolved = resolveConfigSync(raw as any, cfgPath);
    expect(resolved.projects[0]!.canonicalPath).toBe(path.resolve("/tmp/my/proj"));
  });

  it("handles malformed YAML gracefully", () => {
    expect(() => parseConfigContent("::: not yaml ::::", "config.yaml")).toThrow();
  });

  it("handles malformed JSON gracefully", () => {
    expect(() => parseConfigContent("{ invalid json", "config.json")).toThrow();
  });

  it("enforces max lengths via zod (project name)", () => {
    const long = "a".repeat(200);
    const y = `projects:\n  - name: ${long}\n    path: /tmp/x\n`;
    // The zod max is 128, so 200 should fail
    expect(() => parseConfigContent(y, "config.yaml")).toThrow();
  });

  it("resolves non-existent project path to normalized absolute", () => {
    const raw = {
      version: 1,
      projects: [{ name: "ghost", path: "/tmp/does-not-exist-xyz-123", context: [] as string[] }],
      sessionArtifacts: { patterns: [] as string[] },
    };
    const resolved = resolveConfigSync(raw as any, "/tmp/config.yaml");
    expect(resolved.projects[0]!.canonicalPath).toBe("/tmp/does-not-exist-xyz-123");
  });

  it("validates bounded worktree limits as integers", () => {
    expect(() => parseConfigContent(`projects:\n  - name: p\n    path: /tmp/p\nlimits:\n  maxWorktrees: 2.5\n`, "config.yaml")).toThrow();
    const parsed = parseConfigContent(`projects:\n  - name: p\n    path: /tmp/p\nlimits:\n  maxWorktrees: 2\n`, "config.yaml");
    expect(resolveConfigSync(parsed, "/tmp/config.yaml").limits.maxWorktrees).toBe(2);
  });
});
