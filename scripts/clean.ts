import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "fs";
import { isAbsolute, relative, resolve } from "path";

export const CLEAN_TARGETS = [
  "dist",
  "dist/types",
  "packages/opencode-plugin/dist",
] as const;

export type CleanTarget = (typeof CLEAN_TARGETS)[number];

export type CleanResult = {
  target: CleanTarget;
  action: "removed" | "would-remove" | "missing";
  exists: boolean;
};

export type CleanOptions = {
  dryRun?: boolean;
};

const allowedTargets = new Set<string>(CLEAN_TARGETS);

class CleanTargetError extends Error {}

function repositoryRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0 || root.trim().length === 0) {
    throw new CleanTargetError("repository root must not be empty");
  }
  return resolve(root);
}

function normalizeTarget(target: string): CleanTarget {
  if (typeof target !== "string" || target.length === 0 || target.trim().length === 0) {
    throw new CleanTargetError("cleanup target must not be empty");
  }

  const normalized = target.replaceAll("\\", "/");
  const isWindowsAbsolute = /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//");
  if (
    normalized.startsWith("/") ||
    isWindowsAbsolute ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new CleanTargetError("cleanup target must be a safe relative path");
  }

  if (!allowedTargets.has(normalized)) {
    throw new CleanTargetError("cleanup target is not an allowed build output");
  }
  return normalized as CleanTarget;
}

function isContainedPath(root: string, target: string): boolean {
  const child = relative(root, target);
  return (
    child.length > 0 &&
    !isAbsolute(child) &&
    child !== ".." &&
    !child.startsWith("../") &&
    !child.startsWith("..\\")
  );
}

function lstatOrMissing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function removeTree(path: string, root: string): void {
  if (!isContainedPath(root, path)) throw new CleanTargetError("cleanup path escaped the repository root");

  const stats = lstatOrMissing(path);
  if (!stats) return;

  // lstat deliberately keeps symlinks opaque. Unlinking the link itself never
  // opens or recursively removes anything at its destination.
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    unlinkSync(path);
    return;
  }

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (!isContainedPath(root, child)) throw new CleanTargetError("cleanup path escaped the repository root");
    removeTree(child, root);
  }

  // Re-check after visiting children so a directory replaced by a symlink is
  // unlinked as a link rather than passed to a recursive filesystem operation.
  const current = lstatOrMissing(path);
  if (!current) return;
  if (current.isSymbolicLink() || !current.isDirectory()) unlinkSync(path);
  else rmdirSync(path);
}

function rejectSymlinkedParents(root: string, target: string): void {
  const parts = relative(root, target).split(/[\\/]/);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    const stats = lstatOrMissing(current);
    if (!stats) return;
    if (stats.isSymbolicLink() && index < parts.length - 1) {
      throw new CleanTargetError("cleanup target has a symlinked parent");
    }
  }
}

/** Resolve and validate one exact build-output target without touching it. */
export function resolveCleanTarget(root: string, target: string): string {
  const repository = repositoryRoot(root);
  const normalized = normalizeTarget(target);
  const resolved = resolve(repository, ...normalized.split("/"));
  if (!isContainedPath(repository, resolved)) {
    throw new CleanTargetError("cleanup target must stay inside the repository root");
  }
  rejectSymlinkedParents(repository, resolved);
  return resolved;
}

/** Remove one exact allowlisted target, or describe it when dry-run is enabled. */
export function cleanTarget(root: string, target: string, options: CleanOptions = {}): CleanResult {
  const normalized = normalizeTarget(target);
  const repository = repositoryRoot(root);
  const resolved = resolveCleanTarget(repository, normalized);
  const exists = lstatOrMissing(resolved) !== null;

  if (options.dryRun) {
    return { target: normalized, action: "would-remove", exists };
  }
  if (!exists) return { target: normalized, action: "missing", exists: false };

  try {
    removeTree(resolved, repository);
  } catch {
    // Keep CLI errors deterministic and avoid exposing a machine-specific
    // absolute path.
    throw new CleanTargetError(`failed to clean ${normalized}`);
  }
  return { target: normalized, action: "removed", exists: true };
}

/** Remove the supplied exact targets after validating the complete batch. */
export function cleanTargets(
  root: string,
  targets: readonly string[] = CLEAN_TARGETS,
  options: CleanOptions = {},
): CleanResult[] {
  if (targets.length === 0) throw new CleanTargetError("no cleanup targets provided");
  const normalizedTargets = targets.map(normalizeTarget);
  return normalizedTargets.map((target) => cleanTarget(root, target, options));
}

/** Remove all root and plugin build outputs. */
export function cleanRepository(root: string, options: CleanOptions = {}): CleanResult[] {
  return cleanTargets(root, CLEAN_TARGETS, options);
}

export function formatCleanResults(results: readonly CleanResult[]): string {
  return results
    .map(({ target, action }) => `${action === "would-remove" ? "would remove" : action} ${target}`)
    .join("\n");
}

export function parseCleanArgs(args: readonly string[]): { dryRun: boolean; targets: string[] } {
  let dryRun = false;
  const targets: string[] = [];
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CleanTargetError("unknown clean option");
    targets.push(arg);
  }
  return { dryRun, targets };
}

export function runCleanCLI(
  args: readonly string[] = process.argv.slice(2),
  root: string = resolve(import.meta.dir, ".."),
): number {
  try {
    const parsed = parseCleanArgs(args);
    const results = parsed.targets.length === 0
      ? cleanRepository(root, { dryRun: parsed.dryRun })
      : cleanTargets(root, parsed.targets, { dryRun: parsed.dryRun });
    const output = formatCleanResults(results);
    if (output) process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "cleanup failed";
    process.stderr.write(`clean: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(runCleanCLI());
