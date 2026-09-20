import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readContextDocument } from "../providers/documents.js";
import { getBoundedDiff } from "../providers/git.js";
import { SecurityPolicy } from "../core/security.js";
import { cleanup, createGitRepo, git, mkdtemp } from "./helpers.js";

const marker = "\n... [truncated]";
const disposables: string[] = [];
afterEach(async () => { await Promise.all(disposables.splice(0).map(cleanup)); });

// Independent code-point oracle, not a byte-slicing implementation.
function prefix(text: string, budget: number) {
  let result = "";
  for (const point of text) {
    if (Buffer.byteLength(result + point) > budget) break;
    result += point;
  }
  return result;
}
function check(text: string, output: string, truncated: boolean, budget: number) {
  expect(truncated).toBe(Buffer.byteLength(text) > budget);
  expect(output).toBe(prefix(text, budget) + (truncated ? marker : ""));
  const payload = truncated ? output.slice(0, -marker.length) : output;
  expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(budget);
  expect(text.startsWith(payload)).toBe(true);
}

describe("UTF-8 truncation properties", () => {
  it("preserves complete prefixes and exact flags over generated text and byte budgets", async () => {
    const dir = await mkdtemp();
    disposables.push(dir);
    const root = await fs.realpath(dir);
    const project = { name: "test", originalPath: root, canonicalPath: root, contextPatterns: ["*.md"] };
    const policy = new SecurityPolicy([root]);
    const alphabet = ["a", "\n", "é", "界", "😀", "e\u0301", "\r\n", "𝄞"];
    let seed = 0x12345678;
    for (let run = 0; run < 32; run++) {
      let text = "";
      for (let i = 0; i < run; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += alphabet[(seed >>> 16) % alphabet.length];
      }
      await fs.writeFile(path.join(root, "text.md"), text);
      const size = Buffer.byteLength(text);
      for (const budget of new Set([0, 1, 2, 3, 4, 5, Math.floor(size / 2), Math.max(0, size - 1), size, size + 1])) {
        const result = await readContextDocument(project, policy, "text.md", { maxBytes: budget });
        check(text, result.content, result.truncated, budget);
        expect(result.sizeBytes).toBe(size);
      }
    }
  });

  it("preserves diff prefixes at every byte of multibyte text and exact size boundaries", async () => {
    const repo = await createGitRepo();
    disposables.push(repo);
    await fs.writeFile(path.join(repo, "unicode.md"), "é界😀e\u0301\n");
    await git(repo, ["add", "unicode.md"]);
    const args = ["diff", "--cached", "--no-color"];
    const full = await git(repo, args);
    const start = Buffer.byteLength(full.slice(0, full.indexOf("+é")));
    const size = Buffer.byteLength(full);
    const budgets = [0, 1, size, size + 1, ...Array.from({ length: size - start }, (_, i) => start + i)];
    for (const budget of budgets) {
      const result = await getBoundedDiff(repo, args, budget);
      expect(result.diff).not.toBeNull();
      check(full, result.diff!, result.truncated, budget);
    }
  });
});
