/**
 * Property-based truncation invariants.
 *
 * DESIGN.md 3.6 states every provider that can return variable-length data caps
 * it and signals `truncated`. Example-based tests pin a few sizes; these
 * properties assert the bound holds for arbitrary inputs, which is where
 * multi-byte characters and pathological line lengths actually live.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";
import { truncateToBytes, truncateBufferToBytes, TRUNCATION_MARKER } from "../core/truncate.js";
import { searchInProject } from "../providers/search.js";
import { readContextDocument } from "../providers/documents.js";
import { getBoundedDiff } from "../providers/git.js";
import { SecurityPolicy } from "../core/security.js";
import type { ResolvedProject } from "../core/types.js";
import { mkdtemp, cleanup, createGitRepo, commitFile, git } from "./helpers.js";

/** Text likely to sit on a multi-byte boundary: ASCII, accents, CJK, emoji. */
const trickyText = fc.string({
  unit: fc.constantFrom("a", "z", " ", "\n", "é", "ü", "中", "字", "🙂", "👩‍💻", "́", "\t"),
  maxLength: 400,
});

describe("truncateToBytes: the shared byte bound", () => {
  it("never returns more bytes than requested", () => {
    fc.assert(
      fc.property(trickyText, fc.integer({ min: 0, max: 500 }), (text, maxBytes) => {
        const { text: out } = truncateToBytes(text, maxBytes);
        expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(maxBytes);
      }),
      { numRuns: 2000 }
    );
  });

  it("signals truncation exactly when content was dropped", () => {
    fc.assert(
      fc.property(trickyText, fc.integer({ min: 0, max: 500 }), (text, maxBytes) => {
        const { text: out, truncated } = truncateToBytes(text, maxBytes);
        expect(truncated).toBe(Buffer.byteLength(text, "utf-8") > maxBytes);
        if (!truncated) expect(out).toBe(text);
      }),
      { numRuns: 2000 }
    );
  });

  it("returns the input unchanged whenever it already fits", () => {
    fc.assert(
      fc.property(trickyText, (text) => {
        const { text: out, truncated } = truncateToBytes(text, Buffer.byteLength(text, "utf-8"));
        expect(truncated).toBe(false);
        expect(out).toBe(text);
      }),
      { numRuns: 1000 }
    );
  });

  it("never splits a character: output is a prefix of the input", () => {
    fc.assert(
      fc.property(trickyText, fc.integer({ min: 0, max: 500 }), (text, maxBytes) => {
        const { text: out } = truncateToBytes(text, maxBytes);
        // A replacement character would break this: U+FFFD is not in the input.
        expect(text.startsWith(out)).toBe(true);
        expect(out).not.toContain("�");
      }),
      { numRuns: 2000 }
    );
  });

  it("holds the byte bound for buffers that are not valid UTF-8", () => {
    // A bounded read can hand over bytes that are not a complete UTF-8 string.
    // Decoding substitutes U+FFFD, which is three bytes, so a naive decode can
    // grow the payload past the budget it was supposed to respect.
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (bytes, maxBytes) => {
          const out = truncateBufferToBytes(Buffer.from(bytes), maxBytes);
          expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(maxBytes);
        }
      ),
      { numRuns: 3000 }
    );
  });

  it("is monotonic in the budget", () => {
    fc.assert(
      fc.property(
        trickyText,
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (text, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const shorter = truncateToBytes(text, lo).text;
          const longer = truncateToBytes(text, hi).text;
          expect(longer.startsWith(shorter)).toBe(true);
        }
      ),
      { numRuns: 1000 }
    );
  });
});

describe("readContextDocument holds its byte bound", () => {
  let repo: string;
  let real: string;
  let project: ResolvedProject;
  let policy: SecurityPolicy;

  beforeEach(async () => {
    repo = await mkdtemp();
    real = await fs.promises.realpath(repo);
    await fs.promises.mkdir(path.join(real, "docs"), { recursive: true });
    project = {
      name: "prop",
      canonicalPath: real,
      originalPath: repo,
      contextPatterns: ["docs/**/*.md"],
    };
    policy = new SecurityPolicy([real]);
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("caps content at maxBytes for arbitrary unicode documents", async () => {
    await fc.assert(
      fc.asyncProperty(trickyText, fc.integer({ min: 1, max: 300 }), async (text, maxBytes) => {
        const file = path.join(real, "docs", "prop.md");
        await fs.promises.writeFile(file, text, "utf-8");

        const doc = await readContextDocument(project, policy, "docs/prop.md", { maxBytes });
        const body = doc.truncated
          ? doc.content.slice(0, doc.content.length - TRUNCATION_MARKER.length)
          : doc.content;

        expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(maxBytes);
        expect(doc.truncated).toBe(Buffer.byteLength(text, "utf-8") > maxBytes);
        if (doc.truncated) expect(doc.content).toContain("[truncated]");
      }),
      { numRuns: 150 }
    );
  });
});

describe("searchInProject holds its result and preview bounds", () => {
  let repo: string;
  let real: string;
  let project: ResolvedProject;
  let policy: SecurityPolicy;

  beforeEach(async () => {
    repo = await mkdtemp();
    real = await fs.promises.realpath(repo);
    project = { name: "prop", canonicalPath: real, originalPath: repo, contextPatterns: ["**/*"] };
    policy = new SecurityPolicy([real]);
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("never returns more results than maxResults, and flags truncation when it drops any", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 15 }),
        async (hitsPerFile, maxResults) => {
          await fs.promises.rm(path.join(real, "f"), { recursive: true, force: true });
          await fs.promises.mkdir(path.join(real, "f"), { recursive: true });
          let planted = 0;
          for (const [i, hits] of hitsPerFile.entries()) {
            const lines = Array.from({ length: hits }, (_, n) => `line ${n} needle here`);
            planted += hits;
            await fs.promises.writeFile(
              path.join(real, "f", `file-${i}.txt`),
              lines.concat(["no match"]).join("\n"),
              "utf-8"
            );
          }

          const res = await searchInProject({ query: "needle", project, policy, maxResults });

          expect(res.results.length).toBeLessThanOrEqual(maxResults);
          expect(res.results.length).toBeLessThanOrEqual(planted);
          if (res.results.length < planted) expect(res.truncated).toBe(true);
        }
      ),
      { numRuns: 60 }
    );
  });

  it("caps every preview at the documented 300 characters", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 900 }),
        fc.integer({ min: 0, max: 900 }),
        fc.constantFrom("a", "é", "中", "🙂"),
        async (before, after, filler) => {
          const line = filler.repeat(before) + "needle" + filler.repeat(after);
          await fs.promises.writeFile(path.join(real, "long.txt"), line, "utf-8");

          const res = await searchInProject({ query: "needle", project, policy, maxResults: 5 });
          for (const r of res.results) {
            expect(r.preview.length).toBeLessThanOrEqual(300);
          }
        }
      ),
      { numRuns: 60 }
    );
  });

  it("never returns a match whose line or column is out of range", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("needle", "nothing", "a needle b", ""), { minLength: 1, maxLength: 20 }),
        async (lines) => {
          await fs.promises.writeFile(path.join(real, "lines.txt"), lines.join("\n"), "utf-8");

          const res = await searchInProject({ query: "needle", project, policy, maxResults: 50 });
          for (const r of res.results) {
            expect(r.line).toBeGreaterThanOrEqual(1);
            expect(r.line).toBeLessThanOrEqual(lines.length);
            expect(r.column).toBeGreaterThanOrEqual(1);
            expect(r.matchedText).toBe("needle");
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});

describe("getBoundedDiff holds its byte bound", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createGitRepo();
    await commitFile(repo, "seed.txt", "seed\n", "init");
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("caps arbitrary unicode diffs at maxBytes without corrupting them", async () => {
    await fc.assert(
      // The budget starts past the ASCII `diff --git ...` header so the cut
      // lands in the multi-byte payload, which is where the bound is at risk.
      fc.asyncProperty(trickyText, fc.integer({ min: 150, max: 500 }), async (text, maxBytes) => {
        await fs.promises.writeFile(path.join(repo, "changed.txt"), "🙂" + text, "utf-8");
        await git(repo, ["add", "."]);

        const full = (await getBoundedDiff(repo, ["diff", "--cached"], 10 * 1024 * 1024)).diff;
        const { diff, truncated } = await getBoundedDiff(repo, ["diff", "--cached"], maxBytes);
        if (diff === null || full === null) return;

        const body = truncated ? diff.slice(0, diff.length - TRUNCATION_MARKER.length) : diff;
        expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(maxBytes);
        // A cut through a multi-byte character would substitute U+FFFD, so the
        // result would no longer be a prefix of the real diff.
        expect(full.startsWith(body)).toBe(true);
        if (truncated) expect(diff).toContain("[truncated]");
      }),
      { numRuns: 20 }
    );
  }, 120_000);

  it("caps diffstat output the same way", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200 }), async (maxBytes) => {
        await fs.promises.writeFile(path.join(repo, "stat.txt"), "🙂".repeat(50), "utf-8");
        await git(repo, ["add", "."]);

        const { diff, truncated } = await getBoundedDiff(repo, ["diff", "--cached", "--stat"], maxBytes);
        if (diff === null) return;
        const body = truncated ? diff.slice(0, diff.length - TRUNCATION_MARKER.length) : diff;
        expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(maxBytes);
      }),
      { numRuns: 20 }
    );
  }, 120_000);
});
