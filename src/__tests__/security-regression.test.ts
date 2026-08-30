/**
 * Regressions for containment bugs found by the adversarial fixture sweep.
 *
 * Both were reachable through the normal MCP surface, so each case here is
 * pinned at the policy layer and, where the provider path differs, again at the
 * provider layer.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SecurityPolicy, isDeniedByPolicy } from "../core/security.js";
import { discoverContextDocuments, readContextDocument } from "../providers/documents.js";
import type { ResolvedProject } from "../core/types.js";
import { mkdtemp, cleanup } from "./helpers.js";

/**
 * Bug 1 — a symlink inside the root pointing at a path outside it that does not
 * exist *yet* was reported as contained.
 *
 * `realpath` answers ENOENT for a dangling symlink, which the resolver could not
 * tell from "this component does not exist". It therefore re-attached the link's
 * own basename to its parent's realpath and returned `<root>/link` — a path
 * inside the root. A read of that path follows the link out of the root as soon
 * as the target is created.
 */
describe("dangling symlinks are resolved, not mistaken for missing components", () => {
  it("rejects a dangling symlink whose target lies outside the root", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const link = path.join(root, "pending-link");
      await fs.promises.symlink(path.join(outside, "not-created-yet.txt"), link);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(link)).rejects.toThrow(/escapes allowed roots/);
      expect(() => policy.canonicalizeAndCheckSync(link)).toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects a dangling chain whose eventual target lies outside the root", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const mid = path.join(root, "mid-link");
      await fs.promises.symlink(path.join(outside, "absent.txt"), mid);
      const head = path.join(root, "head-link");
      await fs.promises.symlink(mid, head);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(head)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("still resolves a dangling symlink that points back inside the root", async () => {
    const root = await mkdtemp();
    try {
      const link = path.join(root, "inner-pending");
      await fs.promises.symlink(path.join(root, "later.txt"), link);

      const policy = new SecurityPolicy([root]);
      const canonical = await policy.canonicalizeAndCheck(link);
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("still allows a not-yet-created file inside the root", async () => {
    const root = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      const canonical = await policy.canonicalizeAndCheck(path.join(root, "sub", "new.txt"));
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("bounds a cycle of dangling symlinks instead of looping forever", async () => {
    const root = await mkdtemp();
    try {
      // Each link's target is itself a link, and the last one never resolves.
      const a = path.join(root, "cyc-a");
      const b = path.join(root, "cyc-b");
      await fs.promises.symlink(b, a);
      await fs.promises.symlink(a, b);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(a)).rejects.toThrow();
    } finally {
      await cleanup(root);
    }
  });
});

/**
 * Bug 2 — secret-shaped deny globs matched case-sensitively.
 *
 * On a case-insensitive filesystem (macOS default) `MY-SECRET.json` and
 * `my-secret.json` are the same file, so the uppercase spelling served content
 * the lowercase spelling denied.
 */
describe("deny globs are case-folded", () => {
  const projectRoot = "/tmp/project";

  it("denies secret-shaped basenames under any spelling", () => {
    for (const name of [
      "my-secret.json",
      "MY-SECRET.json",
      "My-Secret.json",
      "API_TOKEN.txt",
      "Tokens.txt",
      "CREDENTIAL_store.json",
      "Credentials",
      ".NETRC",
      ".NpmRc",
    ]) {
      expect(
        isDeniedByPolicy(`${projectRoot}/${name}`, projectRoot).denied,
        `${name} should be denied`
      ).toBe(true);
    }
  });

  it("denies node_modules descendants under any spelling", () => {
    expect(isDeniedByPolicy("/tmp/project/Node_Modules/pkg/index.js", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/node_modules/pkg/index.js", projectRoot).denied).toBe(true);
  });

  it("still allows ordinary source files", () => {
    for (const p of ["/tmp/project/src/Index.ts", "/tmp/project/README.md", "/tmp/project/docs/Architecture.md"]) {
      expect(isDeniedByPolicy(p, projectRoot).denied, p).toBe(false);
    }
  });

  it("does not serve a case-variant secret through the document provider", async () => {
    const root = await mkdtemp();
    try {
      const real = await fs.promises.realpath(root);
      await fs.promises.mkdir(path.join(real, "docs"), { recursive: true });
      await fs.promises.writeFile(path.join(real, "docs", "MY-SECRET.md"), "sk-live-abc123");

      const project: ResolvedProject = {
        name: "case-proj",
        canonicalPath: real,
        originalPath: root,
        contextPatterns: ["docs/**/*.md"],
      };
      const policy = new SecurityPolicy([real]);

      const paths = (await discoverContextDocuments(project, policy)).map((d) => d.path);
      expect(paths).not.toContain("docs/MY-SECRET.md");
      await expect(readContextDocument(project, policy, "docs/MY-SECRET.md")).rejects.toThrow(/Denied/);
    } finally {
      await cleanup(root);
    }
  });
});
