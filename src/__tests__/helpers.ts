import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function mkdtemp(prefix = "cb-test-"): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  return stdout as string;
}

export async function createGitRepo(dir?: string): Promise<string> {
  const cwd = dir ?? (await mkdtemp());
  await fs.promises.mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@consistorium.local"]);
  await git(cwd, ["config", "user.name", "Consistorium Test"]);
  return cwd;
}

export async function commitFile(
  cwd: string,
  relPath: string,
  content: string,
  message: string
): Promise<string> {
  const full = path.join(cwd, relPath);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, content, "utf-8");
  await git(cwd, ["add", relPath]);
  await git(cwd, ["commit", "-m", message]);
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  return sha;
}

export async function cleanup(p: string): Promise<void> {
  await fs.promises.rm(p, { recursive: true, force: true });
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
