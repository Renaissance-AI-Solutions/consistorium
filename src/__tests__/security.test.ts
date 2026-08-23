import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SecurityPolicy, isDeniedByPolicy, isBinaryPath } from "../core/security.js";
import { mkdtemp, cleanup } from "./helpers.js";

describe("SecurityPolicy", () => {
  it("allows paths inside allowed root", async () => {
    const root = await mkdtemp();
    try {
      await fs.promises.mkdir(path.join(root, "sub"), { recursive: true });
      const policy = new SecurityPolicy([root]);
      const inside = path.join(root, "sub", "file.txt");
      await fs.promises.writeFile(inside, "hi");
      const canon = await policy.canonicalizeAndCheck(inside);
      expect(canon).toContain("file.txt");
    } finally {
      await cleanup(root);
    }
  });

  it("rejects path traversal via ..", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      const traversal = path.join(root, "..", path.basename(outside), "file.txt");
      await expect(policy.canonicalizeAndCheck(traversal)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("rejects traversal via lexically normalized .. without needing file existence", async () => {
    const root = await mkdtemp();
    try {
      const policy = new SecurityPolicy([root]);
      const victim = "/tmp";
      const traversal = path.join(root, "..", "..", "etc", "passwd");
      // Even if /etc/passwd exists, root is /tmp/cb-test-xxxx, traversal escapes
      if (root !== "/tmp") {
        await expect(policy.canonicalizeAndCheck(traversal)).rejects.toThrow(/escapes allowed roots/);
      }
      // Simple .. from root to sibling
      const sibling = path.join(path.dirname(root), "other");
      await expect(policy.canonicalizeAndCheck(sibling + "/file")).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
    }
  });

  it("prevents symlink escapes from an allowed workspace", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const secret = path.join(outside, "secret.txt");
      await fs.promises.writeFile(secret, "outside secret");

      const linkPath = path.join(root, "link-to-outside");
      await fs.promises.symlink(outside, linkPath);

      const policy = new SecurityPolicy([root]);
      // Accessing via symlink should be denied because realpath escapes root
      const viaLink = path.join(linkPath, "secret.txt");
      await expect(policy.canonicalizeAndCheck(viaLink)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("prevents symlink file escapes", async () => {
    const root = await mkdtemp();
    const outside = await mkdtemp();
    try {
      const secret = path.join(outside, "envfile");
      await fs.promises.writeFile(secret, "SECRET=1");
      const link = path.join(root, "evil-link");
      await fs.promises.symlink(secret, link);
      const policy = new SecurityPolicy([root]);
      await expect(policy.canonicalizeAndCheck(link)).rejects.toThrow(/escapes allowed roots/);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("isInsideAllowedRoot respects separator boundary", () => {
    const policy = new SecurityPolicy(["/tmp/foo"]);
    expect(policy.isInsideAllowedRoot("/tmp/foo")).toBe(true);
    expect(policy.isInsideAllowedRoot("/tmp/foo/bar")).toBe(true);
    expect(policy.isInsideAllowedRoot("/tmp/foobar")).toBe(false);
    expect(policy.isInsideAllowedRoot("/tmp/foo-bar/file")).toBe(false);
    expect(policy.isInsideAllowedRoot("/tmp/foo2")).toBe(false);
  });

  it("handles canonical path with trailing slash normalization", () => {
    const policy = new SecurityPolicy(["/tmp/a/"]);
    // Constructor normalizes trailing slash
    expect(policy.roots[0]).toBe("/tmp/a");
    expect(policy.isInsideAllowedRoot("/tmp/a/b")).toBe(true);
  });
});

describe("isDeniedByPolicy", () => {
  const projectRoot = "/tmp/project";

  it("denies .env", () => {
    expect(isDeniedByPolicy("/tmp/project/.env", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/.ENV", projectRoot).denied).toBe(true);
  });

  it("denies the exact .git basename as well as descendants", () => {
    expect(isDeniedByPolicy("/tmp/project/.git", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/.git/config", projectRoot).denied).toBe(true);
  });

  it("denies .env.*", () => {
    expect(isDeniedByPolicy("/tmp/project/.env.local", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/.env.production", projectRoot).denied).toBe(true);
  });

  it("denies private keys", () => {
    expect(isDeniedByPolicy("/tmp/project/id_rsa", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/cert.pem", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/foo.key", projectRoot).denied).toBe(true);
  });

  it("denies .ssh segment", () => {
    expect(isDeniedByPolicy("/tmp/project/.ssh/id_rsa", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/foo/.ssh/config", projectRoot).denied).toBe(true);
  });

  it("denies .aws and .gnupg", () => {
    expect(isDeniedByPolicy("/tmp/project/.aws/credentials", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/.gnupg/pubring.gpg", projectRoot).denied).toBe(true);
  });

  it("denies *secret* and *token* files", () => {
    expect(isDeniedByPolicy("/tmp/project/my-secret.json", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/tokens.txt", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/nested/credential_store.json", projectRoot).denied).toBe(true);
  });

  it("denies .npmrc and credential files", () => {
    expect(isDeniedByPolicy("/tmp/project/.npmrc", projectRoot).denied).toBe(true);
  });

  it("allows normal source files", () => {
    expect(isDeniedByPolicy("/tmp/project/src/index.ts", projectRoot).denied).toBe(false);
    expect(isDeniedByPolicy("/tmp/project/README.md", projectRoot).denied).toBe(false);
    expect(isDeniedByPolicy("/tmp/project/docs/architecture.md", projectRoot).denied).toBe(false);
  });

  it("denies binary extensions", () => {
    expect(isDeniedByPolicy("/tmp/project/image.png", projectRoot).denied).toBe(true);
    expect(isDeniedByPolicy("/tmp/project/archive.zip", projectRoot).denied).toBe(true);
    expect(isBinaryPath("/tmp/project/image.png")).toBe(true);
    expect(isBinaryPath("/tmp/project/src/app.ts")).toBe(false);
  });

  it("denies binary when allowBinary false, allows when true", () => {
    expect(isDeniedByPolicy("/tmp/project/img.png", projectRoot, { allowBinary: true }).denied).toBe(false);
    expect(isDeniedByPolicy("/tmp/project/img.png", projectRoot, { allowBinary: false }).denied).toBe(true);
  });
});
