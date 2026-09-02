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

  test("rejects skill catalog version drift", () => {
    const files = collectReleaseFiles(root);
    const catalog = JSON.parse(files.get("skills/index.json")!) as {
      skills: Array<{ version: string }>;
    };
    catalog.skills[0]!.version = "9.9.9";
    files.set("skills/index.json", JSON.stringify(catalog));
    expect(validateReleaseFiles(files)).toContain(
      "skills/index.json: skill version must equal 0.4.2",
    );
  });

  test("rejects stale active release pins outside the changelog", () => {
    const files = collectReleaseFiles(root);
    const previousVersion = ["0.4", ".1"].join("");
    files.set("synthetic.md", `bunx @vaur94/agz-memory@${previousVersion}`);
    expect(validateReleaseFiles(files)).toContain(
      "synthetic.md: contains previous active package version",
    );
  });

  test("rejects extra HTTP catalog entries", () => {
    const files = collectReleaseFiles(root);
    const catalog = JSON.parse(files.get("skills/index.json")!) as { skills: unknown[] };
    catalog.skills.push({ name: "unexpected", version: "0.4.2", files: ["unexpected.md"] });
    files.set("skills/index.json", JSON.stringify(catalog));
    expect(validateReleaseFiles(files)).toContain(
      "skills/index.json: must contain exactly one skill",
    );
  });

  test("rejects unexpected HTTP catalog fields", () => {
    const files = collectReleaseFiles(root);
    const catalog = JSON.parse(files.get("skills/index.json")!) as {
      skills: Array<Record<string, unknown>>;
    };
    catalog.skills[0]!.unexpected = true;
    files.set("skills/index.json", JSON.stringify(catalog));
    expect(validateReleaseFiles(files)).toContain(
      "skills/index.json: skill fields must be files, name, and version",
    );
  });

  test("rejects missing skill frontmatter boundaries", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "skills/agz-memory/agz-memory.md",
      files.get("skills/agz-memory/agz-memory.md")!.replace(/^---\n/, ""),
    );
    expect(validateReleaseFiles(files)).toContain(
      "skills/agz-memory/agz-memory.md: invalid required frontmatter",
    );
  });

  test("rejects an empty skill description", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "skills/agz-memory/agz-memory.md",
      files
        .get("skills/agz-memory/agz-memory.md")!
        .replace(/^description: .+$/m, "description:"),
    );
    expect(validateReleaseFiles(files)).toContain(
      "skills/agz-memory/agz-memory.md: invalid required frontmatter",
    );
  });
});
