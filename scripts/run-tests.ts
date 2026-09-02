import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const root = resolve(import.meta.dir, "..");
const packageLink = join(root, "node_modules", "@vaur94", "agz-memory");
const canonicalRoot = realpathSync(root);
let createdLink = false;

const coreBuild = Bun.spawnSync(
  [
    "bun",
    "build",
    "src/core.ts",
    "--target",
    "bun",
    "--format",
    "esm",
    "--packages",
    "external",
    "--outfile",
    "dist/core.js",
  ],
  { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
if (!coreBuild.success) process.exit(coreBuild.exitCode);

if (existsSync(packageLink)) {
  if (!lstatSync(packageLink).isSymbolicLink() || realpathSync(packageLink) !== canonicalRoot) {
    throw new Error(`${packageLink} must link to the repository root for source tests`);
  }
} else {
  mkdirSync(dirname(packageLink), { recursive: true });
  symlinkSync(canonicalRoot, packageLink, process.platform === "win32" ? "junction" : "dir");
  createdLink = true;
}

try {
  const testEnvironment = { ...process.env };
  if (process.platform === "darwin") testEnvironment.TMPDIR = realpathSync(tmpdir());
  const result = Bun.spawnSync(["bun", "test", ...process.argv.slice(2)], {
    cwd: root,
    env: testEnvironment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.signalCode) process.stderr.write(`bun test stopped by ${result.signalCode}\n`);
  process.exitCode = result.exitCode;
} finally {
  if (createdLink && existsSync(packageLink) && lstatSync(packageLink).isSymbolicLink()) {
    unlinkSync(packageLink);
  }
}
