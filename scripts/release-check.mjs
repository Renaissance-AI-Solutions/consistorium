import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const plugin = readJson("plugin.json");
const cliSource = read("src/cli/index.ts");
const appSource = read("src/mcp/app.ts");
const documentationFiles = [
  "README.md",
  "docs/agent-install.md",
  "docs/chatgpt-setup.md",
  "docs/install.md",
  "docs/release-checklist.md",
];

const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock root package", packageLock.packages?.[""]?.version],
  ["plugin.json", plugin.version],
  ["CLI VERSION", cliSource.match(/const VERSION = "([^"]+)"/)?.[1]],
  ["MCP SERVER_VERSION", appSource.match(/SERVER_VERSION = "([^"]+)"/)?.[1]],
]);

const missingVersions = [...versions].filter(([, version]) => !version);
if (missingVersions.length > 0) {
  throw new Error(`Could not read version from: ${missingVersions.map(([name]) => name).join(", ")}`);
}

const uniqueVersions = new Set(versions.values());
if (uniqueVersions.size !== 1) {
  const details = [...versions].map(([name, version]) => `${name}=${version}`).join(", ");
  throw new Error(`Release versions do not match: ${details}`);
}

const packOutput = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: root, encoding: "utf8" },
);
const parsedPack = JSON.parse(packOutput);
const pack = Array.isArray(parsedPack)
  ? parsedPack[0]
  : parsedPack[packageJson.name] ?? Object.values(parsedPack)[0];
if (!pack?.files) {
  throw new Error("npm pack --dry-run did not return a file manifest");
}

const packedFiles = new Set(pack.files.map(({ path }) => path));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/cli/index.js",
  "dist/mcp/server.js",
  "docs/agent-install.md",
  "docs/chatgpt-setup.md",
  "docs/install.md",
  "docs/release-checklist.md",
  "mcp.json",
  "plugin.json",
  "skills/project-state/SKILL.md",
];
const missingFiles = requiredFiles.filter((path) => !packedFiles.has(path));
if (missingFiles.length > 0) {
  throw new Error(`Release package is missing: ${missingFiles.join(", ")}`);
}

const packedTests = [...packedFiles].filter((path) => path.startsWith("dist/__tests__/"));
if (packedTests.length > 0) {
  throw new Error(`Release package contains compiled tests: ${packedTests.join(", ")}`);
}

const brokenLinks = [];
const secretShapedValues = [];
for (const documentationFile of documentationFiles) {
  const contents = read(documentationFile);
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of contents.matchAll(linkPattern)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const localTarget = resolve(root, dirname(documentationFile), decodeURIComponent(target));
    if (!existsSync(localTarget)) brokenLinks.push(`${documentationFile} -> ${target}`);
  }
  if (/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(contents)) {
    secretShapedValues.push(documentationFile);
  }
}
if (brokenLinks.length > 0) {
  throw new Error(`Documentation contains broken local links: ${brokenLinks.join(", ")}`);
}
if (secretShapedValues.length > 0) {
  throw new Error(`Documentation contains secret-shaped values: ${secretShapedValues.join(", ")}`);
}

console.log(
  `release package check: v${packageJson.version}, ${pack.files.length} files, docs/links/binaries present`,
);
