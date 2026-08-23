import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup, createGitRepo, commitFile } from "./helpers.js";
import { discoverContextDocuments, readContextDocument } from "../providers/documents.js";
import { SecurityPolicy } from "../core/security.js";
import type { ResolvedProject } from "../core/types.js";

describe("documents provider", () => {
  let repo: string;
  let project: ResolvedProject;
  let policy: SecurityPolicy;

  beforeEach(async () => {
    repo = await createGitRepo();
    await commitFile(repo, "README.md", "# readme", "init");
    // add docs
    await fs.promises.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "docs", "architecture.md"), "# Arch\ncontent");
    await fs.promises.writeFile(path.join(repo, "TODO.md"), "TODO content");
    await fs.promises.writeFile(path.join(repo, ".env"), "SECRET=1");
    await fs.promises.mkdir(path.join(repo, "reports"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "reports", "summary.md"), "report");

    const real = await fs.promises.realpath(repo);
    project = {
      name: "test-proj",
      canonicalPath: real,
      originalPath: repo,
      contextPatterns: ["TODO.md", "docs/**/*.md", "reports/**/*.md"],
    };
    policy = new SecurityPolicy([real]);
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("discovers only allowlisted documents", async () => {
    const docs = await discoverContextDocuments(project, policy);
    const paths = docs.map((d) => d.path);
    expect(paths).toContain("TODO.md");
    expect(paths).toContain("docs/architecture.md");
    expect(paths).toContain("reports/summary.md");
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain(".env");
  });

  it("does not discover denied files even if glob would match", async () => {
    // Add a secret-named file that would match a permissive glob if we had one
    await fs.promises.writeFile(path.join(repo, "docs", "my-secret.md"), "secret");
    // But our pattern is docs/**/*.md, it would match. Deny should still filter.
    const docs = await discoverContextDocuments(project, policy);
    const paths = docs.map((d) => d.path);
    expect(paths).not.toContain("docs/my-secret.md");
  });

  it("does not discover binary files", async () => {
    await fs.promises.writeFile(path.join(repo, "docs", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const docs = await discoverContextDocuments(project, policy);
    expect(docs.some((d) => d.path === "docs/image.png")).toBe(false);
  });

  it("prevents symlink escapes", async () => {
    const outside = await mkdtemp();
    try {
      const outsideFile = path.join(outside, "outside.md");
      await fs.promises.writeFile(outsideFile, "outside content");
      const link = path.join(repo, "docs", "link-outside");
      await fs.promises.symlink(outside, link);
      const docs = await discoverContextDocuments(project, policy);
      // Should not include anything from outside
      expect(docs.some((d) => d.canonicalPath.startsWith(outside))).toBe(false);
    } finally {
      await cleanup(outside);
    }
  });

  it("reads an allowlisted document", async () => {
    const content = await readContextDocument(project, policy, "TODO.md");
    expect(content.content).toContain("TODO content");
    expect(content.truncated).toBe(false);
    expect(content.path).toBe("TODO.md");
  });

  it("rejects reading non-allowlisted document", async () => {
    await expect(readContextDocument(project, policy, "README.md")).rejects.toThrow(/allowlisted/);
  });

  it("rejects reading .env even if it were allowlisted via *", async () => {
    const permissiveProject: ResolvedProject = { ...project, contextPatterns: ["**/*"] };
    // Even with **/*, .env should be denied by policy
    await expect(readContextDocument(permissiveProject, policy, ".env")).rejects.toThrow(/Denied/);
  });

  it("rejects path traversal", async () => {
    await expect(readContextDocument(project, policy, "../outside.md")).rejects.toThrow(/escapes project/);
    // docs/../../etc/passwd resolves to <project>/../etc/passwd which lexically escapes — we catch lexically
    await expect(readContextDocument(project, policy, "../../etc/passwd")).rejects.toThrow(/escapes project/);
  });

  it("enforces maxBytes truncation", async () => {
    const big = "A".repeat(10240);
    await fs.promises.writeFile(path.join(repo, "docs", "big.md"), big);
    const content = await readContextDocument(project, policy, "docs/big.md", { maxBytes: 100 });
    expect(content.truncated).toBe(true);
    expect(content.content.length).toBeLessThan(500);
    expect(content.content).toContain("[truncated]");
  });

  it("handles binary read denial", async () => {
    await fs.promises.writeFile(path.join(repo, "docs", "binary.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const binaryProj: ResolvedProject = { ...project, contextPatterns: ["docs/*.png"] };
    // Even if glob matches png, binary policy should deny
    await expect(readContextDocument(binaryProj, policy, "docs/binary.png")).rejects.toThrow(/Denied|Binary/);
  });

  it("does not overflow the stack or scan the whole tree on a huge project", async () => {
    // Regression: discovery used to walk every file in the project and then
    // `results.push(...sub)`, which throws RangeError once a single directory
    // holds more entries than V8 accepts as spread arguments.
    const base = await mkdtemp();
    try {
      const bulk = path.join(base, "bulk");
      await fs.promises.mkdir(bulk, { recursive: true });
      for (let i = 0; i < 130_000; i++) {
        await fs.promises.writeFile(path.join(bulk, `f${i}.txt`), "");
      }
      await fs.promises.writeFile(path.join(base, "TODO.md"), "todo content");
      await fs.promises.mkdir(path.join(base, "docs"), { recursive: true });
      await fs.promises.writeFile(path.join(base, "docs", "arch.md"), "# arch");

      const real = await fs.promises.realpath(base);
      const proj: ResolvedProject = {
        name: "huge",
        canonicalPath: real,
        originalPath: base,
        contextPatterns: ["TODO.md", "docs/**/*.md"],
      };
      const docs = await discoverContextDocuments(proj, new SecurityPolicy([real]));
      const paths = docs.map((d) => d.path).sort();
      expect(paths).toEqual(["TODO.md", "docs/arch.md"]);
    } finally {
      await cleanup(base);
    }
  }, 40_000);

  it("resolves literal patterns without walking sibling directories", async () => {
    const noise = path.join(repo, "vendor", "nested");
    await fs.promises.mkdir(noise, { recursive: true });
    await fs.promises.writeFile(path.join(noise, "TODO.md"), "vendored todo");
    const docs = await discoverContextDocuments(project, policy);
    const paths = docs.map((d) => d.path);
    // "TODO.md" is a root-relative literal pattern, not a basename match.
    expect(paths).toContain("TODO.md");
    expect(paths).not.toContain("vendor/nested/TODO.md");
  });

  it("handles repo with spaces in path", async () => {
    const base = await mkdtemp();
    const spaced = path.join(base, "my docs repo");
    try {
      await fs.promises.mkdir(spaced, { recursive: true });
      await fs.promises.writeFile(path.join(spaced, "TODO.md"), "spaced todo");
      const real = await fs.promises.realpath(spaced).catch(() => spaced);
      const proj: ResolvedProject = {
        name: "spaced",
        canonicalPath: real,
        originalPath: spaced,
        contextPatterns: ["TODO.md"],
      };
      const pol = new SecurityPolicy([real]);
      const docs = await discoverContextDocuments(proj, pol);
      expect(docs.some((d) => d.path === "TODO.md")).toBe(true);
    } finally {
      await cleanup(base);
    }
  });
});
