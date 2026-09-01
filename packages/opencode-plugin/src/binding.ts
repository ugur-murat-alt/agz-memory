import { realpathSync } from "fs";
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
  const instanceDirectory = canonical(ctx.location.project.canonical);
  const workspaceID = String(ctx.location.workspaceID ?? "");
  const matches = options.bindings.filter(
    (binding) =>
      binding.opencodeProjectID === String(ctx.location.project.id) &&
      (binding.workspaceID ?? "") === workspaceID,
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error("binding_conflict");
  const configured = matches[0]!;
  const directory = canonical(configured.canonicalDirectory ?? instanceDirectory);
  if (directory !== instanceDirectory) throw new Error("binding_wrong_location");
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
      canonical(location.directory) === binding.directory &&
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
): Promise<boolean> {
  const session = await ctx.session.get({ sessionID });
  return (
    String(session.projectID) === binding.opencodeProjectID &&
    canonical(String(session.location.directory)) === binding.directory &&
    String(session.location.workspaceID ?? "") === binding.workspaceID
  );
}

function canonical(path: string): string {
  return realpathSync(path);
}
