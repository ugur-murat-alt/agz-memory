import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CLEAN_TARGETS,
  cleanRepository,
  cleanTarget,
  resolveCleanTarget,
} from "../../scripts/clean";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { force: true, recursive: true });
});

function makeRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "agz-memory-clean-"));
  temporaryRoots.push(root);
  return root;
}

describe("release build cleanup", () => {
  test("accepts only exact allowlisted relative targets", () => {
    const root = makeRepository();

    expect(resolveCleanTarget(root, "dist")).toBe(join(root, "dist"));
    expect(resolveCleanTarget(root, "packages\\opencode-plugin\\dist")).toBe(
      join(root, "packages", "opencode-plugin", "dist"),
    );

    for (const unsafe of ["", ".", "..", "/", root, "../package.json", "dist/../package.json", "dist/other"]) {
      expect(() => resolveCleanTarget(root, unsafe)).toThrow();
    }
  });

  test("removes the exact build targets without touching neighboring files", () => {
    const root = makeRepository();
    mkdirSync(join(root, "dist", "types"), { recursive: true });
    mkdirSync(join(root, "packages", "opencode-plugin", "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "server.js"), "generated");
    writeFileSync(join(root, "packages", "opencode-plugin", "dist", "index.js"), "generated");
    writeFileSync(join(root, "keep.txt"), "source");

    const results = cleanRepository(root);

    expect(results.map(({ target }) => target)).toEqual([...CLEAN_TARGETS]);
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(existsSync(join(root, "packages", "opencode-plugin", "dist"))).toBe(false);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("source");
  });

  test("unlinks a symlinked target instead of traversing its destination", () => {
    const root = makeRepository();
    const outside = makeRepository();
    writeFileSync(join(outside, "secret.txt"), "must survive");
    symlinkSync(outside, join(root, "dist"), process.platform === "win32" ? "junction" : "dir");

    cleanTarget(root, "dist");

    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("must survive");
  });

  test("removes symlinks inside a target without following them", () => {
    const root = makeRepository();
    const outside = makeRepository();
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "must survive");
    symlinkSync(join(outside, "secret.txt"), join(root, "dist", "secret.txt"));

    cleanTarget(root, "dist");

    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("must survive");
  });

  test("rejects a symlinked parent instead of cleaning outside the repository", () => {
    const root = makeRepository();
    const outside = makeRepository();
    mkdirSync(join(outside, "dist"), { recursive: true });
    writeFileSync(join(outside, "dist", "secret.txt"), "must survive");
    mkdirSync(join(root, "packages"), { recursive: true });
    symlinkSync(
      outside,
      join(root, "packages", "opencode-plugin"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => cleanTarget(root, "packages/opencode-plugin/dist")).toThrow(/symlink/i);
    expect(readFileSync(join(outside, "dist", "secret.txt"), "utf8")).toBe("must survive");
  });

  test("dry-run reports deterministic relative targets without deleting them", () => {
    const root = makeRepository();
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "server.js"), "generated");

    const results = cleanRepository(root, { dryRun: true });

    expect(results).toEqual([
      { target: "dist", action: "would-remove", exists: true },
      { target: "dist/types", action: "would-remove", exists: false },
      { target: "packages/opencode-plugin/dist", action: "would-remove", exists: false },
    ]);
    expect(lstatSync(join(root, "dist"), { throwIfNoEntry: false })).toBeTruthy();
  });
});
