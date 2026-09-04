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

  test("accepts CRLF release files from Windows checkouts", () => {
    const files = new Map(
      [...collectReleaseFiles(root)].map(([path, content]) => [
        path,
        content.replace(/\n/g, "\r\n"),
      ]),
    );
    expect(validateReleaseFiles(files)).toEqual([]);
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

  test("rejects a package version other than the 0.5.1 candidate", () => {
    const files = collectReleaseFiles(root);
    const rootPackage = JSON.parse(files.get("package.json")!) as Record<string, unknown>;
    const plugin = JSON.parse(files.get("packages/opencode-plugin/package.json")!) as Record<
      string,
      unknown
    >;
    rootPackage.version = "0.5.0";
    plugin.version = "0.5.0";
    plugin.dependencies = {
      ...(plugin.dependencies as Record<string, unknown>),
      "@vaur94/agz-memory": "0.5.0",
    };
    files.set("package.json", JSON.stringify(rootPackage));
    files.set("packages/opencode-plugin/package.json", JSON.stringify(plugin));
    expect(validateReleaseFiles(files)).toContain(
      "candidate package version must be 0.5.1, found 0.5.0",
    );
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
      "skills/index.json: skill version must equal 0.5.1",
    );
  });

  test("rejects stale active release pins outside the changelog", () => {
    const files = collectReleaseFiles(root);
    const previousVersion = "0.5.0";
    files.set("synthetic.md", `bunx @vaur94/agz-memory@${previousVersion}`);
    expect(validateReleaseFiles(files)).toContain(
      "synthetic.md: contains previous active package version",
    );
  });

  test("allows the previous release in the historical changelog", () => {
    const files = collectReleaseFiles(root);
    const errors = validateReleaseFiles(files);
    expect(errors).not.toContain("CHANGELOG.md: contains previous active package version");
  });

  test("rejects a missing current security support series", () => {
    const files = collectReleaseFiles(root);
    files.set("SECURITY.md", files.get("SECURITY.md")!.replace("`0.5.x`", "`9.9.x`"));
    expect(validateReleaseFiles(files)).toContain(
      'SECURITY.md: missing "| `0.5.x` | Yes |"',
    );
  });

  test("rejects a missing independent abuse report route", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "SECURITY.md",
      files
        .get("SECURITY.md")!
        .replaceAll("https://support.github.com/contact/report-abuse", "https://example.test/missing"),
    );
    expect(validateReleaseFiles(files)).toContain(
      'SECURITY.md: missing "https://support.github.com/contact/report-abuse"',
    );
  });

  test("rejects extra HTTP catalog entries", () => {
    const files = collectReleaseFiles(root);
    const catalog = JSON.parse(files.get("skills/index.json")!) as { skills: unknown[] };
    catalog.skills.push({ name: "unexpected", version: "0.5.1", files: ["unexpected.md"] });
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

  test("rejects a missing review-resolution row", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "docs/review-resolution.md",
      files.get("docs/review-resolution.md")!.replace(/^\| AGZ-068 \|.*\n/m, ""),
    );
    expect(validateReleaseFiles(files)).toContain(
      "docs/review-resolution.md: must contain exactly AGZ-001 through AGZ-068 in order",
    );
  });

  test("rejects a deferred P1 review finding", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "docs/review-resolution.md",
      files.get("docs/review-resolution.md")!.replace(
        "| AGZ-001 | P1 | Fixed |",
        "| AGZ-001 | P2 | Deferred |",
      ),
    );
    expect(validateReleaseFiles(files)).toContain(
      "docs/review-resolution.md: AGZ-001 priority must remain P1",
    );
  });

  test("rejects a review priority downgrade even when resolution stays fixed", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "docs/review-resolution.md",
      files
        .get("docs/review-resolution.md")!
        .replace("| AGZ-001 | P1 | Fixed |", "| AGZ-001 | P2 | Fixed |"),
    );
    expect(validateReleaseFiles(files)).toContain(
      "docs/review-resolution.md: AGZ-001 priority must remain P1",
    );
  });

  test("rejects empty review evidence", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "docs/review-resolution.md",
      files.get("docs/review-resolution.md")!.replace(/^\| AGZ-068 \|.*$/m, "| AGZ-068 | P2 | Fixed |  |"),
    );
    expect(validateReleaseFiles(files)).toContain(
      "docs/review-resolution.md: AGZ-068 evidence must be non-empty",
    );
  });

  test("rejects review evidence that references a missing file", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "docs/review-resolution.md",
      files
        .get("docs/review-resolution.md")!
        .replace("`scripts/verify-release.ts`", "`scripts/missing-release-verifier.ts`"),
    );
    expect(validateReleaseFiles(files)).toContain(
      "docs/review-resolution.md: AGZ-067 references missing file scripts/missing-release-verifier.ts",
    );
  });

  test("rejects a fixed review row displaced by one unrelated existing file", () => {
    const files = collectReleaseFiles(root);
    files.set(
      "docs/review-resolution.md",
      files
        .get("docs/review-resolution.md")!
        .replace(/^\| AGZ-068 \|.*$/m, "| AGZ-068 | P2 | Fixed | `README.md`. |"),
    );
    expect(validateReleaseFiles(files)).toContain(
      "docs/review-resolution.md: AGZ-068 must reference at least two evidence files",
    );
  });

  test("rejects an unpinned CI action", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@v4"),
    );
    expect(validateReleaseFiles(files)).toContain(
      ".github/workflows/ci.yml: action must use a full commit SHA: - uses: actions/checkout@v4 # v4",
    );
  });

  test("rejects an unpinned upload-artifact action", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "actions/upload-artifact@v4"),
    );
    expect(validateReleaseFiles(files)).toContain(
      ".github/workflows/ci.yml: action must use a full commit SHA: uses: actions/upload-artifact@v4 # v4.6.2",
    );
  });

  test("rejects CI without ref-scoped cancellation", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files.get(".github/workflows/ci.yml")!.replace("cancel-in-progress: true", "cancel-in-progress: false"),
    );
    expect(validateReleaseFiles(files)).toContain(".github/workflows/ci.yml: missing \"cancel-in-progress: true\"");
  });

  test("rejects a migration timing gate with fewer than ten samples", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files.get(".github/workflows/ci.yml")!.replace("--iterations 10", "--iterations 1"),
    );
    expect(validateReleaseFiles(files)).toContain('.github/workflows/ci.yml: missing "--iterations 10"');
  });

  test("rejects a migration timing gate without its JSON artifact", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace('--json "$EVIDENCE_DIR/migration-timing.json"', '--json timing.json'),
    );
    expect(validateReleaseFiles(files)).toContain(
      '.github/workflows/ci.yml: missing "--json \\\"$EVIDENCE_DIR/migration-timing.json\\\""',
    );
  });

  test("rejects an evidence upload that can be skipped after a failure", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace(
          "      - name: Upload compatibility test evidence\n        if: always()",
          "      - name: Upload compatibility test evidence",
        ),
    );
    expect(validateReleaseFiles(files)).toContain(
      ".github/workflows/ci.yml: compatibility evidence upload must run with if: always()",
    );
  });

  test("rejects an evidence manifest not bound to the workflow commit", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files.get(".github/workflows/ci.yml")!.replace("EVIDENCE_SHA: ${{ github.sha }}", "EVIDENCE_SHA: local"),
    );
    expect(validateReleaseFiles(files)).toContain(
      '.github/workflows/ci.yml: missing "EVIDENCE_SHA: ${{ github.sha }}"',
    );
  });

  test("rejects a partial Dependabot ignore for the compatibility-locked SDK", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/dependabot.yml",
      files
        .get(".github/dependabot.yml")!
        .replaceAll(
          '      - dependency-name: "@opencode-ai/plugin"',
          '      - dependency-name: "@opencode-ai/plugin"\n        versions: ["1.x"]',
        ),
    );
    const errors = validateReleaseFiles(files);
    expect(errors).toContain(
      ".github/dependabot.yml: / must ignore all @opencode-ai/plugin updates",
    );
    expect(errors).toContain(
      ".github/dependabot.yml: /packages/opencode-plugin must ignore all @opencode-ai/plugin updates",
    );
  });

  test("rejects a static package tarball version", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace("vaur94-agz-memory-${VERSION}.tgz", "vaur94-agz-memory-0.5.1.tgz"),
    );
    expect(validateReleaseFiles(files)).toContain(
      '.github/workflows/ci.yml: missing "CORE_TARBALL=\\"$RUNNER_TEMP/agz-pack/vaur94-agz-memory-${VERSION}.tgz\\""',
    );
  });

  test("rejects CI that does not start the packed MCP", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace('bun "$GITHUB_WORKSPACE/scripts/verify-packed-mcp.ts"', 'bun "$GITHUB_WORKSPACE/scripts/removed-packed-check.ts"'),
    );
    expect(validateReleaseFiles(files)).toContain(
      '.github/workflows/ci.yml: missing "bun \\"$GITHUB_WORKSPACE/scripts/verify-packed-mcp.ts\\""',
    );
  });

  test("rejects CI that reads the packaged doctor schema from the wrong field", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace("r.health?.schemaVersion!==11", "r.schemaVersion!==11"),
    );
    expect(validateReleaseFiles(files)).toContain(
      '.github/workflows/ci.yml: missing "r.health?.schemaVersion!==11"',
    );
  });

  test("rejects CI that upgrades instead of doctoring the packaged MCP database", () => {
    const files = collectReleaseFiles(root);
    files.set(
      ".github/workflows/ci.yml",
      files
        .get(".github/workflows/ci.yml")!
        .replace("./node_modules/.bin/agz-memory-admin doctor > doctor.json", "./node_modules/.bin/agz-memory-admin upgrade --to 11 > doctor.json"),
    );
    expect(validateReleaseFiles(files)).toContain(
      '.github/workflows/ci.yml: missing "./node_modules/.bin/agz-memory-admin doctor > doctor.json"',
    );
  });
});
