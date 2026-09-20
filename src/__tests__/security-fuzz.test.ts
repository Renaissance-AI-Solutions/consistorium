import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SecurityPolicy } from "../core/security.js";
import { cleanup, mkdtemp } from "./helpers.js";

const disposables: string[] = [];
afterEach(async () => { await Promise.all(disposables.splice(0).map(cleanup)); });

async function fixture() {
  const dir = await mkdtemp("cb-containment-");
  disposables.push(dir);
  const root = path.join(dir, "Workspace");
  const outside = path.join(dir, "Workspace-sibling");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "inside.md"), "inside");
  await fs.writeFile(path.join(outside, "outside.md"), "outside");
  return { root, outside, policy: new SecurityPolicy([root]) };
}

async function rejected(policy: SecurityPolicy, candidate: string) {
  await expect(policy.canonicalizeAndCheck(candidate), candidate).rejects.toThrow();
  expect(() => policy.canonicalizeAndCheckSync(candidate), candidate).toThrow();
}

// Fixed seeds make generated cases reproducible on every filesystem.
function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}

describe("adversarial containment fixtures", () => {
  it("checks generated traversal, sibling-prefix and symlink paths against realpath", async () => {
    const { root, outside, policy } = await fixture();
    await fs.symlink(outside, path.join(root, "escape"));
    await fs.symlink(root, path.join(root, "alias"));
    const next = random(0xc0ffee);
    for (let i = 0; i < 160; i++) {
      const prefix = ["", "./", "alias/", "alias/../"][next() % 4]!;
      const tail = ["inside.md", "escape/outside.md", "../Workspace-sibling/outside.md", "alias/inside.md"][(next() >>> 8) % 4]!;
      const candidate = `${root}/${prefix}${tail}`;
      const real = await fs.realpath(path.resolve(candidate));
      const relative = path.relative(await fs.realpath(root), real);
      const inside = relative === "" || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..");
      if (inside) {
        expect(await policy.canonicalizeAndCheck(candidate)).toBe(real);
        expect(policy.canonicalizeAndCheckSync(candidate)).toBe(real);
      } else {
        await rejected(policy, candidate);
      }
    }
    for (const suffix of ["missing.md", "missing/deep/file.md"]) {
      await rejected(policy, path.join(root, "escape", suffix));
      await rejected(policy, path.join(outside, suffix));
      expect(await policy.canonicalizeAndCheck(path.join(root, suffix)))
        .toBe(path.join(await fs.realpath(root), suffix));
    }
  });

  it("fails closed on dangling symlinks, loops, and overlong chains", async () => {
    const { root, outside, policy } = await fixture();
    await fs.symlink(path.join(outside, "missing"), path.join(root, "dangling"));
    await rejected(policy, path.join(root, "dangling"));
    await rejected(policy, path.join(root, "dangling", "child.md"));
    await fs.symlink("loop-b", path.join(root, "loop-a"));
    await fs.symlink("loop-a", path.join(root, "loop-b"));
    await rejected(policy, path.join(root, "loop-a", "child.md"));
    for (const length of [4, 16, 64]) {
      for (let i = length - 1; i >= 0; i--) {
        const target = i === length - 1 ? outside : `chain-${length}-${i + 1}`;
        await fs.symlink(target, path.join(root, `chain-${length}-${i}`));
      }
      await rejected(policy, path.join(root, `chain-${length}-0`, "outside.md"));
      await rejected(policy, path.join(root, `chain-${length}-0`, "missing.md"));
    }
  });

  it("uses filesystem identity for case and Unicode aliases, never string folding", async () => {
    const { root, outside } = await fixture();
    for (const [name, alias] of [["CaseRoot", "caseroot"], ["caf\u00e9", "cafe\u0301"], ["A", "\u0410"]]) {
      const allowed = path.join(root, name!);
      const variant = path.join(root, alias!);
      await fs.mkdir(allowed);
      await fs.writeFile(path.join(allowed, "file.md"), "allowed");
      // On a folding filesystem this is the same directory; otherwise a sibling.
      await fs.mkdir(variant, { recursive: true });
      await fs.writeFile(path.join(variant, "file.md"), "fixture");
      const policy = new SecurityPolicy([allowed]);
      const target = path.join(variant, "file.md");
      if (await fs.realpath(allowed) === await fs.realpath(variant)) {
        expect(await policy.canonicalizeAndCheck(target)).toBe(await fs.realpath(target));
        expect(policy.canonicalizeAndCheckSync(target)).toBe(await fs.realpath(target));
      } else {
        await rejected(policy, target);
      }
      await fs.symlink(outside, path.join(allowed, "escape"));
      await rejected(policy, path.join(variant, "escape", "outside.md"));
    }
  });

  it("accepts descendants when the filesystem root itself is allowed", async () => {
    const { root } = await fixture();
    const policy = new SecurityPolicy([path.parse(root).root]);
    const real = await fs.realpath(root);
    expect(await policy.canonicalizeAndCheck(root)).toBe(real);
    expect(policy.canonicalizeAndCheckSync(root)).toBe(real);
    expect(() => policy.assertInside(real, path.parse(root).root)).not.toThrow();
  });
});
