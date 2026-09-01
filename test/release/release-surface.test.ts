import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import {
  collectReleaseFiles,
  validateReleaseFiles,
} from "../../scripts/verify-release";

const root = resolve(import.meta.dir, "../..");

describe("release surface", () => {
  test("accepts the final repository surface", () => {
    expect(validateReleaseFiles(collectReleaseFiles(root))).toEqual([]);
  });

  test("rejects package version drift", () => {
    const files = collectReleaseFiles(root);
    const plugin = JSON.parse(files.get("packages/opencode-plugin/package.json")!) as Record<
      string,
      unknown
    >;
    plugin.version = "9.9.9";
    files.set("packages/opencode-plugin/package.json", JSON.stringify(plugin));
    expect(validateReleaseFiles(files)).toContain("core and plugin package versions differ");
  });

  test("rejects bilingual section drift", () => {
    const files = collectReleaseFiles(root);
    files.set("README.tr.md", files.get("README.tr.md")!.replace("## Lisans", "## Eksik"));
    expect(validateReleaseFiles(files)).toContain(
      "README.tr.md: level-two sections differ from the release contract",
    );
  });

  test("rejects a reintroduced retired name", () => {
    const files = collectReleaseFiles(root);
    const retiredName = ["opencode", "2", "-memory"].join("");
    files.set("synthetic.txt", retiredName);
    expect(validateReleaseFiles(files)).toContain("synthetic.txt: contains retired project name");
  });
});
