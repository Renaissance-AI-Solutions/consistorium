import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup, createGitRepo, commitFile } from "./helpers.js";
import { searchInProject } from "../providers/search.js";
import { SecurityPolicy } from "../core/security.js";
import type { ResolvedProject } from "../core/types.js";

describe("search provider", () => {
  let repo: string;
  let project: ResolvedProject;
  let policy: SecurityPolicy;

  beforeEach(async () => {
    repo = await createGitRepo();
    await commitFile(repo, "README.md", "# readme", "init");
    await fs.promises.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "src", "app.ts"), "export const hello = 'world';\n// TODO fix\n");
    await fs.promises.writeFile(path.join(repo, "src", "secret-token.txt"), "api_token=sk-abc123");
    await fs.promises.writeFile(path.join(repo, ".env"), "SECRET=1");
    await fs.promises.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "docs", "notes.md"), "searchable content here");

    // Node modules should be excluded
    await fs.promises.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "hello world");

    const real = await fs.promises.realpath(repo);
    project = {
      name: "test-proj",
      canonicalPath: real,
      originalPath: repo,
      contextPatterns: ["**/*"],
    };
    policy = new SecurityPolicy([real]);
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("finds matches and returns file/line/preview", async () => {
    const res = await searchInProject({ query: "hello", project, policy });
    expect(res.results.length).toBeGreaterThan(0);
    const hit = res.results.find((r) => r.path.includes("app.ts"));
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(1);
    expect(hit!.preview).toContain("hello");
    expect(res.provenance.projectName).toBe("test-proj");
  });

  it("excludes node_modules and secret files", async () => {
    const res = await searchInProject({ query: "hello", project, policy });
    expect(res.results.some((r) => r.path.includes("node_modules"))).toBe(false);
    // secret-token.txt is denied by *token* glob, so its content should not be searchable
    // But hello is not in that file; test that searching for api_token returns no hit from that file
    const res2 = await searchInProject({ query: "api_token", project, policy });
    expect(res2.results.some((r) => r.path.includes("secret-token"))).toBe(false);
  });

  it("excludes .env files", async () => {
    const res = await searchInProject({ query: "SECRET", project, policy });
    expect(res.results.some((r) => r.path.includes(".env"))).toBe(false);
  });

  it("respects maxResults truncation", async () => {
    // Create many files with same term
    for (let i = 0; i < 5; i++) {
      await fs.promises.writeFile(path.join(repo, `file${i}.txt`), "repeatme repeatme\nsecond line repeatme\n");
    }
    const res = await searchInProject({ query: "repeatme", project, policy, maxResults: 3 });
    expect(res.results.length).toBe(3);
    expect(res.truncated).toBe(true);
    expect(res.totalMatches).toBeGreaterThanOrEqual(3);
  });

  it("is case-insensitive by default, case-sensitive when flagged", async () => {
    await fs.promises.writeFile(path.join(repo, "case.txt"), "Hello HELLO hello");
    const insensitive = await searchInProject({ query: "hello", project, policy, caseSensitive: false });
    expect(insensitive.results.some((r) => r.path === "case.txt")).toBe(true);

    const sensitive = await searchInProject({ query: "HELLO", project, policy, caseSensitive: true });
    // Should match line with HELLO exactly
    expect(sensitive.results.some((r) => r.path === "case.txt" && r.preview.includes("HELLO"))).toBe(true);
    // Lowercase search case-sensitive should still find lowercase occurrence
    const low = await searchInProject({ query: "hello", project, policy, caseSensitive: true });
    expect(low.results.some((r) => r.path === "case.txt")).toBe(true);
  });

  it("rejects empty query", async () => {
    await expect(searchInProject({ query: "", project, policy })).rejects.toThrow(/non-empty/);
  });

  it("rejects too-long query", async () => {
    const long = "a".repeat(501);
    await expect(searchInProject({ query: long, project, policy })).rejects.toThrow(/too long/);
  });

  it("skips binary files", async () => {
    await fs.promises.writeFile(path.join(repo, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    const res = await searchInProject({ query: "\x89", project, policy });
    expect(res.results.some((r) => r.path.endsWith(".png"))).toBe(false);
  });

  it("skips symlink escapes", async () => {
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "outside.txt"), "unique-term-outside");
      const link = path.join(repo, "link-out");
      await fs.promises.symlink(outside, link);
      const res = await searchInProject({ query: "unique-term-outside", project, policy });
      expect(res.results.length).toBe(0);
    } finally {
      await cleanup(outside);
    }
  });

  it("previews are bounded and single-line", async () => {
    const longLine = "a".repeat(500) + " needle " + "b".repeat(500);
    await fs.promises.writeFile(path.join(repo, "long.txt"), longLine);
    const res = await searchInProject({ query: "needle", project, policy });
    const hit = res.results.find((r) => r.path === "long.txt");
    expect(hit).toBeDefined();
    expect(hit!.preview.length).toBeLessThanOrEqual(310); // 300 + ellipsis
  });
});
