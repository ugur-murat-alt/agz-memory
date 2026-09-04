import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Plugin } from "@opencode-ai/plugin";
import type { MemoryCore } from "@vaur94/agz-memory/core";
import {
  eventMatchesLocation,
  resolveBinding,
  sessionMatchesBinding,
} from "../src/binding";
import type { MemoryPluginOptions } from "../src/config";

describe("plugin binding locations", () => {
  test("matches a repository and linked worktree without changing persisted binding paths", async () => {
    const directory = mkdtempSync("/tmp/agz-memory-plugin-worktree-");
    const main = join(directory, "main");
    const linked = join(directory, "linked");
    const unrelated = join(directory, "unrelated");
    const suspicious = join(directory, "suspicious");
    try {
      git(directory, "init", main);
      git(main, "config", "user.email", "tests@example.com");
      git(main, "config", "user.name", "AGZ Memory tests");
      writeFileSync(join(main, "README.md"), "fixture\n");
      git(main, "add", "README.md");
      git(main, "commit", "-m", "fixture");
      git(main, "worktree", "add", "-b", "linked-fixture", linked);
      git(directory, "init", unrelated);

      const mainPath = realpathSync(main);
      const linkedPath = realpathSync(linked);
      const mainCaptures: string[] = [];
      const linkedContext = fakeContext(linked, "oc-project", "workspace-1");
      const binding = resolveBinding(linkedContext, fakeCore(mainCaptures), bindingOptions(mainPath))!;

      expect(binding.directory).toBe(mainPath);
      expect(mainCaptures).toEqual([mainPath]);
      expect(eventMatchesLocation({ directory: linked, workspaceID: "workspace-1" }, binding)).toBe(true);
      expect(await sessionMatchesBinding(linkedContext, "session-1", binding)).toBe(true);
      expect(eventMatchesLocation({ directory: unrelated, workspaceID: "workspace-1" }, binding)).toBe(false);

      const linkedCaptures: string[] = [];
      const mainContext = fakeContext(main, "oc-project", "workspace-1");
      const worktreeBinding = resolveBinding(
        mainContext,
        fakeCore(linkedCaptures),
        bindingOptions(linkedPath),
      )!;
      expect(worktreeBinding.directory).toBe(linkedPath);
      expect(linkedCaptures).toEqual([linkedPath]);
      expect(eventMatchesLocation({ directory: main, workspaceID: "workspace-1" }, worktreeBinding)).toBe(true);
      expect(await sessionMatchesBinding(mainContext, "session-2", worktreeBinding)).toBe(true);

      mkdirSync(suspicious);
      const linkedGitDirectory = readFileSync(join(linked, ".git"), "utf8")
        .replace(/^gitdir: /, "")
        .trim();
      writeFileSync(
        join(suspicious, ".git"),
        `gitdir: ${linkedGitDirectory}\n`,
      );
      expect(eventMatchesLocation({ directory: suspicious, workspaceID: "workspace-1" }, binding)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function bindingOptions(canonicalDirectory: string): MemoryPluginOptions {
  return {
    mode: "shadow-capture",
    autoCreateProjects: false,
    bindings: [{
      memoryProjectID: "11111111-1111-4111-8111-111111111111",
      opencodeProjectID: "oc-project",
      canonicalDirectory,
      workspaceID: "workspace-1",
    }],
    capture: { enabled: true, allowedKinds: ["preference"], minConfidence: 0.95 },
    retrieval: { semanticBackend: "none", timeoutMs: 300, maxCards: 8, maxCharacters: 4_800 },
  };
}

function fakeCore(canonicalDirectories: string[]): MemoryCore {
  return {
    capture: {
      bindProject(input: { memoryProjectID: string; canonicalDirectory: string }) {
        canonicalDirectories.push(input.canonicalDirectory);
        return { bindingKey: "binding-key", projectID: input.memoryProjectID };
      },
    },
  } as unknown as MemoryCore;
}

function fakeContext(directory: string, projectID: string, workspaceID: string): Plugin.Context {
  return {
    location: {
      project: { id: projectID, directory, canonical: directory },
      workspaceID,
    },
    session: {
      async get() {
        return { projectID, location: { directory, workspaceID } };
      },
    },
  } as unknown as Plugin.Context;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}
