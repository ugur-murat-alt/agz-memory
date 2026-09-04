import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import type { Plugin } from "@opencode-ai/plugin";
import type { MemoryCore } from "@vaur94/agz-memory/core";
import type { MemoryPluginOptions } from "./config";

export interface ActiveBinding {
  bindingKey: string;
  projectID: string;
  directory: string;
  workspaceID: string;
  opencodeProjectID: string;
}

export function resolveBinding(
  ctx: Plugin.Context,
  core: MemoryCore,
  options: MemoryPluginOptions,
): ActiveBinding | undefined {
  const instanceDirectory = resolvedPath(ctx.location.project.canonical);
  const workspaceID = String(ctx.location.workspaceID ?? "");
  const matches = options.bindings.filter(
    (binding) =>
      binding.opencodeProjectID === String(ctx.location.project.id) &&
      (binding.workspaceID ?? "") === workspaceID,
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error("binding_conflict");
  const configured = matches[0]!;
  const directory = resolvedPath(configured.canonicalDirectory ?? instanceDirectory);
  if (!sameLocation(directory, instanceDirectory)) throw new Error("binding_wrong_location");
  const persisted = core.capture.bindProject({
    memoryProjectID: configured.memoryProjectID,
    opencodeProjectID: configured.opencodeProjectID,
    canonicalDirectory: directory,
    workspaceID,
  });
  return {
    bindingKey: persisted.bindingKey,
    projectID: persisted.projectID,
    directory,
    workspaceID,
    opencodeProjectID: configured.opencodeProjectID,
  };
}

export function eventMatchesLocation(
  location: { directory: string; workspaceID?: string } | undefined,
  binding: ActiveBinding,
): boolean | undefined {
  if (!location) return undefined;
  try {
    return (
      sameLocation(location.directory, binding.directory) &&
      String(location.workspaceID ?? "") === binding.workspaceID
    );
  } catch {
    return false;
  }
}

export async function sessionMatchesBinding(
  ctx: Plugin.Context,
  sessionID: string,
  binding: ActiveBinding,
  signal?: AbortSignal,
): Promise<boolean> {
  const session = await ctx.session.get({ sessionID }, { signal });
  return (
    String(session.projectID) === binding.opencodeProjectID &&
    sameLocation(String(session.location.directory), binding.directory) &&
    String(session.location.workspaceID ?? "") === binding.workspaceID
  );
}

const MAX_GIT_METADATA_BYTES = 4_096;

function resolvedPath(path: string): string {
  return realpathSync(path);
}

function sameLocation(left: string, right: string): boolean {
  const leftPath = resolvedPath(left);
  const rightPath = resolvedPath(right);
  if (sameDirectory(leftPath, rightPath)) return true;
  const leftCommonDirectory = commonGitDirectory(leftPath);
  const rightCommonDirectory = commonGitDirectory(rightPath);
  return (
    leftCommonDirectory !== undefined &&
    rightCommonDirectory !== undefined &&
    sameDirectory(leftCommonDirectory, rightCommonDirectory)
  );
}

function commonGitDirectory(worktreeRoot: string): string | undefined {
  try {
    const worktreeGitFile = join(worktreeRoot, ".git");
    if (isDirectory(worktreeGitFile)) return realpathSync(worktreeGitFile);
    const gitDirectoryReference = gitMetadata(worktreeGitFile, "gitdir: ");
    if (!gitDirectoryReference) return undefined;

    const gitDirectory = realpathSync(resolve(worktreeRoot, gitDirectoryReference));
    if (!isDirectory(gitDirectory)) return undefined;
    const commonDirectoryReference = gitMetadata(join(gitDirectory, "commondir"));
    if (!commonDirectoryReference) return undefined;

    const sharedGitDirectory = realpathSync(resolve(gitDirectory, commonDirectoryReference));
    if (!isDirectory(sharedGitDirectory) || !pathsEqual(basename(sharedGitDirectory), ".git")) return undefined;
    if (!isWithin(gitDirectory, sharedGitDirectory)) return undefined;

    const mainRoot = dirname(sharedGitDirectory);
    if (!sameDirectory(realpathSync(join(mainRoot, ".git")), sharedGitDirectory)) return undefined;

    const recordedWorktreeGitFile = gitMetadata(join(gitDirectory, "gitdir"));
    if (!recordedWorktreeGitFile) return undefined;
    if (!pathsEqual(
      realpathSync(resolve(gitDirectory, recordedWorktreeGitFile)),
      realpathSync(worktreeGitFile),
    )) {
      return undefined;
    }
    return sharedGitDirectory;
  } catch {
    return undefined;
  }
}

function gitMetadata(file: string, prefix = ""): string | undefined {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_GIT_METADATA_BYTES) {
    return undefined;
  }
  const content = readFileSync(file, "utf8");
  const value = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  if (!value.startsWith(prefix)) return undefined;
  const path = value.slice(prefix.length);
  return path && !/[\0\r\n]/.test(path) ? path : undefined;
}

function isDirectory(path: string): boolean {
  return lstatSync(path).isDirectory();
}

function pathsEqual(left: string, right: string): boolean {
  return pathComparisonKey(left) === pathComparisonKey(right);
}

function sameDirectory(left: string, right: string): boolean {
  if (pathsEqual(left, right)) return true;
  if (process.platform !== "win32") return false;
  const leftStats = statSync(left);
  const rightStats = statSync(right);
  return (
    leftStats.isDirectory() &&
    rightStats.isDirectory() &&
    leftStats.ino !== 0 &&
    leftStats.dev === rightStats.dev &&
    leftStats.ino === rightStats.ino
  );
}

function pathComparisonKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function isWithin(path: string, parent: string): boolean {
  const remainder = relative(pathComparisonKey(parent), pathComparisonKey(path));
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}
