/**
 * Adversarial path-containment fixtures.
 *
 * Each block builds a synthetic tree under a tempdir and asserts the single
 * invariant the containment layer exists to hold: a path that the operating
 * system would resolve outside every allowed root is never reported as inside
 * one. Failing closed (throwing, or returning a path that is genuinely inside)
 * is always acceptable; reporting an escaping path as contained is not.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SecurityPolicy, isDeniedByPolicy } from "../core/security.js";
import { mkdtemp, cleanup } from "./helpers.js";

/** True when the filesystem backing `dir` matches names case-insensitively. */
async function isCaseInsensitiveFs(dir: string): Promise<boolean> {
  const probe = path.join(dir, "CaseProbe");
  await fs.promises.writeFile(probe, "probe");
  try {
    await fs.promises.stat(path.join(dir, "caseprobe"));
    return true;
  } catch {
    return false;
  } finally {
    await fs.promises.rm(probe, { force: true });
  }
}

/** True when the filesystem collapses NFC/NFD spellings onto one file. */
async function isUnicodeNormalizingFs(dir: string): Promise<boolean> {
  const nfc = path.join(dir, "café-probe.md"); // é as one code point
  const nfd = path.join(dir, "café-probe.md"); // e + combining acute
  await fs.promises.writeFile(nfc, "probe");
  try {
    await fs.promises.stat(nfd);
    return true;
  } catch {
    return false;
  } finally {
    await fs.promises.rm(nfc, { force: true });
    await fs.promises.rm(nfd, { force: true });
  }
}

/**
 * Build a chain of `length` symlinks under `dir`, the last pointing at `target`.
 * Returns the head of the chain — the link a caller would actually request.
 */
async function buildSymlinkChain(dir: string, length: number, target: string): Promise<string> {
  let current = target;
  for (let i = 0; i < length; i++) {
    const link = path.join(dir, `chain-${i}`);
    await fs.promises.symlink(current, link);
    current = link;
  }
  return current;
}

/**
 * Assert the containment invariant: `canonicalizeAndCheck` either throws, or
 * returns a path that really is inside one of the policy's roots.
 */
async function expectContained(policy: SecurityPolicy, requested: string): Promise<void> {
  let canonical: string;
  try {
    canonical = await policy.canonicalizeAndCheck(requested);
  } catch {
    // Any throw is a valid outcome: a PolicyError is an explicit refusal, and a
    // filesystem errno (ENOTDIR for a file used as a directory, ELOOP for a
    // symlink cycle) still denies access. Only a *returned* escaping path fails.
    return;
  }
  expect(
    policy.isInsideAllowedRoot(canonical),
    `canonicalizeAndCheck(${requested}) returned ${canonical}, which is outside every allowed root`
  ).toBe(true);
}

describe("path containment: symlink chains", () => {
  it("resolves a long chain that stays inside the root", async () => {
    const root = await mkdtemp();
    try {
      const inside = path.join(root, "target.txt");
      await fs.promises.writeFile(inside, "ok");
      const head = await buildSymlinkChain(root, 8, inside);

      const policy = new SecurityPolicy([root]);
      const canonical = await policy.canonicalizeAndCheck(head);
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("rejects a long chain whose final target escapes the root", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const secret = path.join(outside, "loot.txt");
      await fs.promises.writeFile(secret, "outside secret");
      const head = await buildSymlinkChain(root, 12, secret);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(head)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects a chain that leaves the root mid-way and stays out", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      // root/in-a -> root/in-b -> outside/hop -> outside/loot.txt
      const loot = path.join(outside, "loot.txt");
      await fs.promises.writeFile(loot, "outside secret");
      const hop = path.join(outside, "hop");
      await fs.promises.symlink(loot, hop);
      const inB = path.join(root, "in-b");
      await fs.promises.symlink(hop, inB);
      const inA = path.join(root, "in-a");
      await fs.promises.symlink(inB, inA);

      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(inA)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("allows a chain that detours outside but lands back inside the root", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      // The realpath is the ground truth: a detour that terminates inside the
      // root is contained, however many hops it took to get there.
      const home = path.join(root, "home.txt");
      await fs.promises.writeFile(home, "inside");
      const detour = path.join(outside, "detour");
      await fs.promises.symlink(home, detour);
      const head = path.join(root, "head");
      await fs.promises.symlink(detour, head);

      const policy = new SecurityPolicy([root]);
      const canonical = await policy.canonicalizeAndCheck(head);
      expect(canonical).toBe(await fs.promises.realpath(home));
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("does not report a self-referential symlink loop as contained", async () => {
    const root = await mkdtemp();
    try {
      const a = path.join(root, "loop-a");
      const b = path.join(root, "loop-b");
      await fs.promises.symlink(b, a);
      await fs.promises.symlink(a, b);

      const policy = new SecurityPolicy([root]);
      // ELOOP must not be mistaken for "missing tail, therefore inside".
      await expect(policy.canonicalizeAndCheck(a)).rejects.toThrow();
    } finally {
      await cleanup(root);
    }
  });

});

describe("path containment: traversal through symlinked parents", () => {
  it("never lands outside the root when .. is applied to a symlinked parent", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const outsideDir = path.join(outside, "dir");
      await fs.promises.mkdir(outsideDir, { recursive: true });
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      const link = path.join(root, "link-to-outside-dir");
      await fs.promises.symlink(outsideDir, link);

      const policy = new SecurityPolicy([root]);
      for (const attempt of [
        path.join(link, "..", "loot.txt"),
        path.join(link, "..", "..", "loot.txt"),
        path.join(link, "sub", "..", "..", "loot.txt"),
        `${link}/./../loot.txt`,
      ]) {
        await expectContained(policy, attempt);
      }
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects .. escapes reached through a symlinked directory that exists", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const outsideDir = path.join(outside, "dir");
      await fs.promises.mkdir(outsideDir, { recursive: true });
      const sibling = path.join(outsideDir, "sibling.txt");
      await fs.promises.writeFile(sibling, "outside secret");
      const link = path.join(root, "d");
      await fs.promises.symlink(outsideDir, link);

      const policy = new SecurityPolicy([root]);
      // Real OS resolution of `<root>/d/sibling.txt` is outside the root.
      await expect(policy.canonicalizeAndCheck(path.join(link, "sibling.txt"))).rejects.toThrow(
        /escapes allowed roots/
      );
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("holds the invariant across a sweep of traversal payloads", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      await fs.promises.mkdir(path.join(root, "a", "b", "c"), { recursive: true });
      await fs.promises.symlink(outside, path.join(root, "esc"));

      const policy = new SecurityPolicy([root]);
      const segments = ["..", ".", "a", "b", "esc", "loot.txt", "", "//"];
      const payloads: string[] = [];
      // Deterministic sweep over every 4-segment combination.
      for (const s1 of segments) {
        for (const s2 of segments) {
          for (const s3 of segments) {
            for (const s4 of segments) {
              payloads.push([root, s1, s2, s3, s4].join("/"));
            }
          }
        }
      }
      expect(payloads.length).toBe(segments.length ** 4);
      for (const payload of payloads) {
        await expectContained(policy, payload);
      }
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });
});

describe("path containment: case-insensitive filesystem edges", () => {
  it("denies secret-shaped basenames regardless of case", () => {
    const projectRoot = "/tmp/project";
    for (const name of [
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

  it("denies .git descendants regardless of case", () => {
    const projectRoot = "/tmp/project";
    for (const p of ["/tmp/project/.GIT/config", "/tmp/project/.Git", "/tmp/project/sub/.GIT/HEAD"]) {
      expect(isDeniedByPolicy(p, projectRoot).denied, `${p} should be denied`).toBe(true);
    }
  });

  it("denies denied path segments regardless of case", () => {
    const projectRoot = "/tmp/project";
    for (const p of ["/tmp/project/.SSH/config", "/tmp/project/.AWS/credentials", "/tmp/project/.Kube/config"]) {
      expect(isDeniedByPolicy(p, projectRoot).denied, `${p} should be denied`).toBe(true);
    }
  });

  it("keeps containment when the same directory is reached under a different case", async () => {
    const root = await mkdtemp();
    try {
      if (!(await isCaseInsensitiveFs(root))) return; // Linux/ext4: distinct files, nothing to prove
      await fs.promises.mkdir(path.join(root, "sub"), { recursive: true });
      const file = path.join(root, "sub", "doc.md");
      await fs.promises.writeFile(file, "hi");

      const policy = new SecurityPolicy([root]);
      const canonical = await policy.canonicalizeAndCheck(path.join(root, "SUB", "DOC.md"));
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  it("does not let a case-variant spelling of the root escape containment", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      await fs.promises.writeFile(path.join(outside, "loot.txt"), "outside secret");
      const policy = new SecurityPolicy([root]);
      await expectContained(policy, path.join(outside.toUpperCase(), "loot.txt"));
      await expectContained(policy, path.join(outside, "LOOT.TXT"));
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });
});

describe("path containment: unicode normalization collisions", () => {
  const NFC_NAME = "café.md"; // é as U+00E9
  const NFD_NAME = "café.md"; // e + U+0301

  it("treats both spellings consistently when the filesystem collapses them", async () => {
    const root = await mkdtemp();
    try {
      if (!(await isUnicodeNormalizingFs(root))) return;
      await fs.promises.writeFile(path.join(root, NFC_NAME), "content");

      const policy = new SecurityPolicy([root]);
      // Both spellings name the same file, so both must be reported contained.
      for (const name of [NFC_NAME, NFD_NAME]) {
        const canonical = await policy.canonicalizeAndCheck(path.join(root, name));
        expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
      }
    } finally {
      await cleanup(root);
    }
  });

  it("denies a unicode-spelled secret under either normalization", () => {
    const projectRoot = "/tmp/project";
    // "clé" — a lookalike pair around a denied *secret* substring.
    for (const name of [`clé-secret.json`, `clé-secret.json`]) {
      expect(isDeniedByPolicy(`${projectRoot}/${name}`, projectRoot).denied, name).toBe(true);
    }
  });

  it("does not let a unicode-normalized lookalike escape the root", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      // A sibling directory whose name differs from the root only by normalization.
      const lookalike = path.join(path.dirname(root), path.basename(root).normalize("NFD"), "loot.txt");
      await expectContained(policy, lookalike);
      await expectContained(policy, path.join(outside.normalize("NFD"), "loot.txt"));
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });
});

describe("path containment: .git deny machinery on real trees", () => {
  it("denies .git contents discovered through a symlink inside the project", async () => {
    const root = await mkdtemp();
    try {
      const gitDir = path.join(root, ".git");
      await fs.promises.mkdir(gitDir, { recursive: true });
      await fs.promises.writeFile(path.join(gitDir, "config"), "[core]\n");
      const link = path.join(root, "peek");
      await fs.promises.symlink(gitDir, link);

      const policy = new SecurityPolicy([root]);
      // Containment holds (it really is inside), but policy must still deny it.
      const canonical = await policy.canonicalizeAndCheck(path.join(link, "config"));
      expect(policy.isInsideAllowedRoot(canonical)).toBe(true);
      expect(isDeniedByPolicy(canonical, root).denied).toBe(true);
    } finally {
      await cleanup(root);
    }
  });
});
