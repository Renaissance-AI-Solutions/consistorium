/**
 * Adversarial fixtures for two containment classes the first sweep did not
 * reach: paths at filesystem length boundaries, and re-checks across a tree
 * that changed between calls.
 *
 * Same invariant as `security-fuzz.test.ts`: a path the OS would resolve
 * outside every allowed root is never *reported* as inside one. Throwing —
 * `PolicyError` or a raw errno such as ENAMETOOLONG — is always acceptable.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SecurityPolicy } from "../core/security.js";
import { mkdtemp, cleanup } from "./helpers.js";

/** macOS caps a single path component at 255 bytes; 300 is over the line. */
const NAME_MAX = 255;

async function expectContained(policy: SecurityPolicy, requested: string): Promise<void> {
  let canonical: string;
  try {
    canonical = await policy.canonicalizeAndCheck(requested);
  } catch {
    return; // failing closed is a valid outcome
  }
  expect(
    policy.isInsideAllowedRoot(canonical),
    `canonicalizeAndCheck(${requested}) returned ${canonical}, outside every allowed root`
  ).toBe(true);
}

/** Create `depth` nested single-character directories, returning the leaf. */
async function nest(root: string, depth: number): Promise<string> {
  let cur = root;
  for (let i = 0; i < depth; i++) {
    cur = path.join(cur, "d");
    await fs.promises.mkdir(cur);
  }
  return cur;
}

describe("path containment: length boundaries", () => {
  it("contains a file at the bottom of a deeply nested tree", async () => {
    const root = await mkdtemp();
    try {
      const leaf = await nest(root, 300);
      const file = path.join(leaf, "deep.txt");
      await fs.promises.writeFile(file, "deep");

      const policy = new SecurityPolicy([root]);
      const canonical = await policy.canonicalizeAndCheck(file);
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("rejects a symlink escape planted at the bottom of a deep tree", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      const leaf = await nest(root, 250);
      const link = path.join(leaf, "escape");
      await fs.promises.symlink(outside, link);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(path.join(link, "loot.txt"))).rejects.toThrow(
        /escapes allowed roots/
      );
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("holds the invariant for a lexical path far past PATH_MAX", async () => {
    const root = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      // Never created on disk — the resolver must handle it lexically.
      const inside = path.join(root, ...Array.from({ length: 800 }, () => "seg"));
      await expectContained(policy, inside);

      // The same length, but escaping.
      const escaping = path.join(root, ...Array.from({ length: 800 }, () => ".."), "etc", "passwd");
      await expectContained(policy, escaping);
    } finally {
      await cleanup(root);
    }
  });

  it("holds the invariant for a component at and past NAME_MAX", async () => {
    const root = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      // At the limit: creatable, and must be contained.
      const atLimit = path.join(root, "y".repeat(NAME_MAX));
      await fs.promises.mkdir(atLimit);
      const canonical = await policy.canonicalizeAndCheck(path.join(atLimit, "f.txt"));
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);

      // Past the limit: ENAMETOOLONG must not become "missing, therefore inside".
      await expectContained(policy, path.join(root, "x".repeat(300)));
      await expectContained(policy, path.join(root, "x".repeat(300), "child.txt"));
    } finally {
      await cleanup(root);
    }
  });

  it("rejects an over-long component on a path that escapes", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      await expectContained(policy, path.join(outside, "x".repeat(300)));
      await expectContained(policy, path.join(outside, "x".repeat(300), "loot.txt"));
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects a deep .. chain that climbs above the root", async () => {
    const root = await mkdtemp();
    try {
      const leaf = await nest(root, 60);
      const policy = new SecurityPolicy([root]);
      // Enough `..` to leave the root even from 60 levels down.
      const climb = path.join(leaf, ...Array.from({ length: 200 }, () => ".."), "etc", "passwd");
      await expect(policy.canonicalizeAndCheck(climb)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
    }
  });
});

/**
 * The resolver keeps no per-path state, so every call re-reads the tree. These
 * fixtures lock that in: a cache added later would make an earlier verdict
 * outlive the filesystem that justified it, which is the TOCTOU-adjacent
 * failure worth guarding against. They are sequential, not concurrent — a swap
 * racing a single `realpath` is not deterministically testable here.
 */
describe("path containment: re-checks after the tree changes", () => {
  it("rejects a link that was contained until it was repointed outside", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const inside = path.join(root, "target.txt");
      await fs.promises.writeFile(inside, "inside");
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      const link = path.join(root, "link");
      await fs.promises.symlink(inside, link);

      const policy = new SecurityPolicy([root]);
      expect(policy.isInsideAllowedRoot(await policy.canonicalizeAndCheck(link))).toBe(true);

      await fs.promises.unlink(link);
      await fs.promises.symlink(path.join(outside, "loot.txt"), link);

      await expect(policy.canonicalizeAndCheck(link)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("accepts a link that was escaping until it was repointed inside", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      const inside = path.join(root, "target.txt");
      await fs.promises.writeFile(inside, "inside");
      const link = path.join(root, "link");
      await fs.promises.symlink(path.join(outside, "loot.txt"), link);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(link)).rejects.toThrow(/escapes allowed roots/);

      await fs.promises.unlink(link);
      await fs.promises.symlink(inside, link);

      // No stale negative verdict either.
      expect(policy.isInsideAllowedRoot(await policy.canonicalizeAndCheck(link))).toBe(true);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects a pending path once it becomes an escaping symlink", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      const pending = path.join(root, "pending");

      // Nothing there yet: a not-yet-created file inside the root is contained.
      expect(policy.isInsideAllowedRoot(await policy.canonicalizeAndCheck(pending))).toBe(true);

      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      await fs.promises.symlink(path.join(outside, "loot.txt"), pending);

      await expect(policy.canonicalizeAndCheck(pending)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects a directory replaced by an escaping symlink", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const dir = path.join(root, "docs");
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, "note.md"), "inside");
      await fs.promises.mkdir(path.join(outside, "docs"), { recursive: true });
      await fs.promises.writeFile(path.join(outside, "docs", "note.md"), "outside secret");

      const policy = new SecurityPolicy([root]);
      const target = path.join(dir, "note.md");
      expect(policy.isInsideAllowedRoot(await policy.canonicalizeAndCheck(target))).toBe(true);

      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.symlink(path.join(outside, "docs"), dir);

      await expect(policy.canonicalizeAndCheck(target)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("keeps the sync resolver consistent with the async one across a swap", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      const inside = path.join(root, "target.txt");
      await fs.promises.writeFile(inside, "inside");
      const link = path.join(root, "link");
      await fs.promises.symlink(inside, link);

      const policy = new SecurityPolicy([root]);
      expect(policy.canonicalizeAndCheckSync(link)).toBe(await policy.canonicalizeAndCheck(link));

      await fs.promises.unlink(link);
      await fs.promises.symlink(path.join(outside, "loot.txt"), link);

      expect(() => policy.canonicalizeAndCheckSync(link)).toThrow(/escapes allowed roots/);
      await expect(policy.canonicalizeAndCheck(link)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });
});
