import { homedir } from "os";
import { join } from "path";
import { Plugin } from "@opencode-ai/plugin";
import {
  openMemoryCore,
  SUPPORTED_OPENCODE_VERSION,
  type MemoryCore,
} from "@vaur94/agz-memory/core";
import { resolveBinding } from "./binding";
import { parseOptions } from "./config";
import { PluginRuntime } from "./runtime";

export default Plugin.define({
  id: "agz-memory",
  async setup(ctx) {
    let options: ReturnType<typeof parseOptions>;
    try {
      options = parseOptions(ctx.options);
    } catch {
      process.stderr.write(
        `${JSON.stringify({
          component: "agz-memory-plugin",
          operation: "setup",
          outcome: "disabled",
          error_code: "invalid_configuration",
        })}\n`,
      );
      return;
    }
    if (options.mode === "off" || options.bindings.length === 0) return;
    if (ctx.app.version !== SUPPORTED_OPENCODE_VERSION) {
      process.stderr.write(
        `${JSON.stringify({
          component: "agz-memory-plugin",
          operation: "setup",
          outcome: "disabled",
          error_code: "opencode_version_mismatch",
        })}\n`,
      );
      return;
    }
    const databasePath =
      process.env.OPENCODE_MEMORY_DATABASE_PATH?.trim() ||
      join(process.env.HOME ?? homedir(), ".local", "share", "opencode-memory", "memory.sqlite");
    let core: MemoryCore | undefined;
    try {
      const activeCore = openMemoryCore(databasePath);
      core = activeCore;
      const binding = resolveBinding(ctx, activeCore, options);
      if (!binding) {
        activeCore.close();
        return;
      }
      const runtime = new PluginRuntime(ctx, activeCore, options, binding);
      await runtime.start();
      return async () => {
        await runtime.stop();
        activeCore.close();
      };
    } catch (error) {
      core?.close();
      process.stderr.write(
        `${JSON.stringify({
          component: "agz-memory-plugin",
          operation: "setup",
          outcome: "disabled",
          error_code: error instanceof Error && /binding/i.test(error.message) ? "binding_conflict" : "database_unavailable",
        })}\n`,
      );
      return;
    }
  },
});
