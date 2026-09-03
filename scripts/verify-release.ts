import { resolve } from "path";
import { readFileSync } from "fs";

const CORE_PACKAGE = "@vaur94/agz-memory";
const PLUGIN_PACKAGE = "@vaur94/agz-memory-plugin";
const RETIRED_NAME = ["opencode", "2", "-memory"].join("");
const RETIRED_VERSION = ["0.4.0", "beta.1"].join("-");
const PREVIOUS_VERSION = ["0.4", ".2"].join("");
const SINGLE_FILE_REVIEW_EVIDENCE = new Set(["061", "062", "063", "065"]);
const SKILL_FRONTMATTER = `---
name: AGZ Memory
description: Use project-scoped AGZ Memory for durable facts and decisions across sessions; recall relevant history and safely store verified outcomes.
slash: false
---
`;

const README_SECTIONS = [
  ["Why AGZ Memory", "Neden AGZ Memory"],
  ["Compatibility", "Uyumluluk"],
  ["Install The MCP Server", "MCP Sunucusunu Kurma"],
  ["Use The Nine Tools", "Dokuz Aracı Kullanma"],
  ["Add The Optional Plugin", "İsteğe Bağlı Eklentiyi Ekleme"],
  ["Bind Projects Explicitly", "Projeleri Açıkça Eşleme"],
  ["Roll Out Safely", "Güvenli Devreye Alma"],
  ["Operate And Recover", "İşletme Ve Kurtarma"],
  ["Security Model", "Güvenlik Modeli"],
  ["Develop And Verify", "Geliştirme Ve Doğrulama"],
  ["Project Resources", "Proje Kaynakları"],
  ["License", "Lisans"],
] as const;

const RUNBOOK_SECTIONS = [
  ["Preconditions", "Ön Koşullar"],
  ["Health Check And Upgrade", "Sağlık Kontrolü Ve Yükseltme"],
  ["Verify A Backup", "Yedeği Doğrulama"],
  ["Restore Rehearsal", "Geri Yükleme Provası"],
  ["Post-Restore Validation", "Geri Yükleme Sonrası Doğrulama"],
  ["Retained Maintenance Gate", "Korunan Bakım Kapısı"],
  ["Stale Migration Lock", "Eski Geçiş Kilidi"],
  ["Prune Verified Backups", "Doğrulanmış Yedekleri Temizleme"],
  ["Abort Conditions", "İptal Koşulları"],
] as const;

export function collectReleaseFiles(root: string): Map<string, string> {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  }
  const files = new Map<string, string>();
  for (const path of new TextDecoder().decode(result.stdout).split("\0").filter(Boolean)) {
    if (/\.(?:gif|jpe?g|png|webp|ico|pdf)$/i.test(path) || path === "LICENSE") continue;
    files.set(path, normalizeText(readFileSync(resolve(root, path), "utf8")));
  }
  return files;
}

export function validateReleaseFiles(files: ReadonlyMap<string, string>): string[] {
  files = new Map(
    [...files].map(([path, content]) => [path, normalizeText(content)]),
  );
  const errors: string[] = [];
  const required = [
    "README.md",
    "README.tr.md",
    "ARCHITECTURE.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "docs/backup-restore-runbook.md",
    "docs/backup-restore-runbook.tr.md",
    "docs/review-resolution.md",
    "packages/opencode-plugin/README.md",
    "packages/opencode-plugin/README.tr.md",
    "skills/index.json",
    "skills/agz-memory/agz-memory.md",
  ];
  for (const path of required) {
    if (!files.has(path)) errors.push(`missing required release file: ${path}`);
  }

  for (const [path, content] of files) {
    if (content.includes(RETIRED_NAME)) errors.push(`${path}: contains retired project name`);
    if (path !== "CHANGELOG.md" && content.includes(RETIRED_VERSION)) {
      errors.push(`${path}: contains retired package version`);
    }
    if (
      path !== "CHANGELOG.md" &&
      !path.startsWith("artifacts/baseline/") &&
      content.includes(PREVIOUS_VERSION)
    ) {
      errors.push(`${path}: contains previous active package version`);
    }
  }

  const rootPackage = parsePackage(files, "package.json", errors);
  const pluginPackage = parsePackage(files, "packages/opencode-plugin/package.json", errors);
  const version = stringField(rootPackage, "version", "package.json", errors);
  const pluginVersion = stringField(
    pluginPackage,
    "version",
    "packages/opencode-plugin/package.json",
    errors,
  );
  if (version && pluginVersion !== version) errors.push("core and plugin package versions differ");
  const dependency = nestedString(pluginPackage, ["dependencies", CORE_PACKAGE]);
  if (version && dependency !== version) {
    errors.push(`plugin dependency on ${CORE_PACKAGE} must equal ${version}`);
  }
  if (version && version !== "0.5.0") errors.push(`final package version must be 0.5.0, found ${version}`);

  if (version) {
    requireText(files, "src/version.ts", `PRODUCT_VERSION = "${version}"`, errors);
    requireText(
      files,
      "packages/opencode-plugin/src/version.ts",
      `PLUGIN_VERSION = "${version}"`,
      errors,
    );
    requireText(files, "README.md", `${CORE_PACKAGE}@${version}`, errors);
    requireText(files, "README.md", `${PLUGIN_PACKAGE}@${version}`, errors);
    requireText(files, "README.tr.md", `${CORE_PACKAGE}@${version}`, errors);
    requireText(files, "README.tr.md", `${PLUGIN_PACKAGE}@${version}`, errors);
    requireText(files, "packages/opencode-plugin/README.md", `${CORE_PACKAGE}@${version}`, errors);
    requireText(files, "packages/opencode-plugin/README.md", `${PLUGIN_PACKAGE}@${version}`, errors);
    requireText(files, "packages/opencode-plugin/README.tr.md", `${CORE_PACKAGE}@${version}`, errors);
    requireText(files, "packages/opencode-plugin/README.tr.md", `${PLUGIN_PACKAGE}@${version}`, errors);
    requireText(files, "CHANGELOG.md", `## [${version}] - `, errors);
    requireText(files, "SECURITY.md", `| \`${version.replace(/\.\d+$/, ".x")}\` | Yes |`, errors);
    requireText(files, "SECURITY.md", "https://support.github.com/contact/report-abuse", errors);
    const skillSource = `https://raw.githubusercontent.com/ugur-murat-alt/agz-memory/v${version}/skills/`;
    requireText(files, "README.md", skillSource, errors);
    requireText(files, "README.tr.md", skillSource, errors);
  }
  requireText(files, "src/types.ts", "SCHEMA_VERSION = 11", errors);
  requireText(files, "README.md", "| SQLite schema | `11` |", errors);
  requireText(files, "README.tr.md", "| SQLite schema | `11` |", errors);
  validateReviewResolution(files, errors);
  validateCI(files, errors);
  validateDependabot(files, errors);

  compareSections(files, "README.md", "README.tr.md", README_SECTIONS, errors);
  compareSections(
    files,
    "docs/backup-restore-runbook.md",
    "docs/backup-restore-runbook.tr.md",
    RUNBOOK_SECTIONS,
    errors,
  );

  const filesList = Array.isArray(rootPackage?.files) ? rootPackage.files : [];
  if (!filesList.includes("docs/backup-restore-runbook.tr.md")) {
    errors.push("core package files must include the Turkish runbook");
  }
  if (!filesList.includes("docs/schema-v11.md") || !filesList.includes("docs/review-resolution.md")) {
    errors.push("core package files must include schema and review resolution documentation");
  }
  if (!filesList.includes("skills/index.json") || !filesList.includes("skills/agz-memory/agz-memory.md")) {
    errors.push("core package files must include the versioned agz-memory skill catalog");
  }
  validateSkillCatalog(files, version, errors);
  const pluginFiles = Array.isArray(pluginPackage?.files) ? pluginPackage.files : [];
  if (!pluginFiles.includes("README.tr.md")) {
    errors.push("plugin package files must include README.tr.md");
  }
  return errors;
}

function normalizeText(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function validateCI(files: ReadonlyMap<string, string>, errors: string[]): void {
  const path = ".github/workflows/ci.yml";
  const content = files.get(path) ?? "";
  const required = [
    "os: ubuntu-latest",
    "os: macos-latest",
    "os: windows-latest",
    "bun: 1.3.14",
    "bun: latest",
    "bun run test:property",
    "bun run test:stress",
    "bun run test:restore",
    "bun run benchmark:gate",
    "github/codeql-action/init@",
    "github/codeql-action/analyze@",
    "actions/dependency-review-action@",
    'CORE_TARBALL="$RUNNER_TEMP/agz-pack/vaur94-agz-memory-${VERSION}.tgz"',
    'PLUGIN_TARBALL="$RUNNER_TEMP/agz-pack/vaur94-agz-memory-plugin-${VERSION}.tgz"',
    'bun "$GITHUB_WORKSPACE/scripts/verify-packed-mcp.ts"',
    "./node_modules/.bin/agz-memory-admin doctor > doctor.json",
    "r.health?.schemaVersion!==11",
  ];
  for (const expected of required) requireText(files, path, expected, errors);
  for (const line of content.split("\n").filter((value) => /^\s*- uses:/.test(value))) {
    if (!/@[0-9a-f]{40}(?:\s|$)/.test(line.replace(/\s+#.*$/, ""))) {
      errors.push(`${path}: action must use a full commit SHA: ${line.trim()}`);
    }
  }
}

function validateDependabot(files: ReadonlyMap<string, string>, errors: string[]): void {
  const path = ".github/dependabot.yml";
  const content = files.get(path) ?? "";
  const sections = content.split(/(?=^  - package-ecosystem:)/m);
  for (const directory of ["/", "/packages/opencode-plugin"]) {
    const section = sections.find(
      (candidate) =>
        candidate.startsWith("  - package-ecosystem: npm\n") &&
        candidate.includes(`    directory: ${directory}\n`),
    );
    if (!section || !hasUnqualifiedPluginIgnore(section)) {
      errors.push(`${path}: ${directory} must ignore all @opencode-ai/plugin updates`);
    }
  }
}

function hasUnqualifiedPluginIgnore(section: string): boolean {
  const lines = section.split("\n");
  const ignoreIndex = lines.indexOf("    ignore:");
  if (ignoreIndex < 0) return false;
  const ignoreEnd = lines.findIndex(
    (line, index) => index > ignoreIndex && /^    \S[^:]*:/.test(line),
  );
  const ignoreLines = lines.slice(ignoreIndex + 1, ignoreEnd < 0 ? undefined : ignoreEnd);
  const dependencyIndex = ignoreLines.indexOf(
    '      - dependency-name: "@opencode-ai/plugin"',
  );
  if (dependencyIndex < 0) return false;
  const nextSetting = ignoreLines
    .slice(dependencyIndex + 1)
    .find((line) => line.trim() && !line.trimStart().startsWith("#"));
  return !nextSetting?.startsWith("        ");
}

function validateReviewResolution(
  files: ReadonlyMap<string, string>,
  errors: string[],
): void {
  const content = files.get("docs/review-resolution.md") ?? "";
  const rows = [...content.matchAll(/^\| AGZ-(\d{3}) \| (P[0-3]) \| (Fixed|Proven not applicable|Deferred) \| (.*) \|$/gm)];
  const expected = Array.from({ length: 68 }, (_, index) => String(index + 1).padStart(3, "0"));
  const actual = rows.map((match) => match[1]!);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push("docs/review-resolution.md: must contain exactly AGZ-001 through AGZ-068 in order");
  }
  const p1Findings = new Set([
    ...Array.from({ length: 24 }, (_, index) => String(index + 1).padStart(3, "0")),
    "027",
    "028",
    "032",
    "034",
    "035",
    "036",
    "037",
    "041",
    "043",
    "044",
    "045",
    "046",
    "047",
    "049",
    "050",
    "052",
    "053",
    "055",
    "057",
  ]);
  const p3Findings = new Set(["061", "066", "067"]);
  for (const row of rows) {
    const expectedPriority = p1Findings.has(row[1]!)
      ? "P1"
      : p3Findings.has(row[1]!)
        ? "P3"
        : "P2";
    if (row[2] !== expectedPriority) {
      errors.push(
        `docs/review-resolution.md: AGZ-${row[1]} priority must remain ${expectedPriority}`,
      );
    }
  }
  if (rows.some((match) => (match[2] === "P0" || match[2] === "P1") && match[3] === "Deferred")) {
    errors.push("docs/review-resolution.md: P0/P1 findings cannot be deferred");
  }
  for (const row of rows) {
    const finding = `AGZ-${row[1]}`;
    const evidence = row[4]!.trim();
    if (!evidence) {
      errors.push(`docs/review-resolution.md: ${finding} evidence must be non-empty`);
      continue;
    }
    const references = [...evidence.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]!)
      .filter((reference) => reference.includes("/") || /\.(?:json|md|ts|yml)$/.test(reference));
    if (references.length === 0) {
      errors.push(`docs/review-resolution.md: ${finding} must reference an evidence file`);
      continue;
    }
    if (
      row[3] === "Fixed" &&
      references.length < 2 &&
      !SINGLE_FILE_REVIEW_EVIDENCE.has(row[1]!)
    ) {
      errors.push(`docs/review-resolution.md: ${finding} must reference at least two evidence files`);
    }
    for (const reference of references) {
      if (!files.has(reference)) {
        errors.push(`docs/review-resolution.md: ${finding} references missing file ${reference}`);
      }
    }
  }
}

function validateSkillCatalog(
  files: ReadonlyMap<string, string>,
  version: string | undefined,
  errors: string[],
): void {
  const catalog = parsePackage(files, "skills/index.json", errors);
  if (JSON.stringify(Object.keys(catalog ?? {}).sort()) !== JSON.stringify(["skills"])) {
    errors.push("skills/index.json: root fields must contain only skills");
  }
  const skills = Array.isArray(catalog?.skills) ? catalog.skills : [];
  if (skills.length !== 1) {
    errors.push("skills/index.json: must contain exactly one skill");
  }
  const skill = skills[0];
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
    errors.push("skills/index.json: must define the agz-memory skill");
    return;
  }
  const record = skill as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify(["files", "name", "version"])
  ) {
    errors.push("skills/index.json: skill fields must be files, name, and version");
  }
  if (record.name !== "agz-memory") errors.push("skills/index.json: unexpected skill name");
  if (version && record.version !== version) {
    errors.push(`skills/index.json: skill version must equal ${version}`);
  }
  if (JSON.stringify(record.files) !== JSON.stringify(["agz-memory.md"])) {
    errors.push("skills/index.json: agz-memory files must contain agz-memory.md");
  }
  if (!files.get("skills/agz-memory/agz-memory.md")?.startsWith(SKILL_FRONTMATTER)) {
    errors.push("skills/agz-memory/agz-memory.md: invalid required frontmatter");
  }
}

export function assertReleaseSurface(root: string): void {
  const errors = validateReleaseFiles(collectReleaseFiles(root));
  if (errors.length > 0) throw new Error(`release verification failed:\n- ${errors.join("\n- ")}`);
}

function compareSections(
  files: ReadonlyMap<string, string>,
  englishPath: string,
  turkishPath: string,
  pairs: readonly (readonly [string, string])[],
  errors: string[],
): void {
  const english = headings(files.get(englishPath));
  const turkish = headings(files.get(turkishPath));
  const expectedEnglish = pairs.map(([heading]) => heading);
  const expectedTurkish = pairs.map(([, heading]) => heading);
  if (JSON.stringify(english) !== JSON.stringify(expectedEnglish)) {
    errors.push(`${englishPath}: level-two sections differ from the release contract`);
  }
  if (JSON.stringify(turkish) !== JSON.stringify(expectedTurkish)) {
    errors.push(`${turkishPath}: level-two sections differ from the release contract`);
  }
}

function headings(content: string | undefined): string[] {
  return content ? [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]!) : [];
}

function parsePackage(
  files: ReadonlyMap<string, string>,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  const content = files.get(path);
  if (!content) {
    errors.push(`missing package manifest: ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    errors.push(`${path}: invalid JSON`);
    return undefined;
  }
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
  path: string,
  errors: string[],
): string | undefined {
  const result = value?.[field];
  if (typeof result !== "string" || !result) {
    errors.push(`${path}: ${field} must be a non-empty string`);
    return undefined;
  }
  return result;
}

function nestedString(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function requireText(
  files: ReadonlyMap<string, string>,
  path: string,
  expected: string,
  errors: string[],
): void {
  if (!files.get(path)?.includes(expected)) errors.push(`${path}: missing ${JSON.stringify(expected)}`);
}

if (import.meta.main) {
  assertReleaseSurface(resolve(import.meta.dir, ".."));
  process.stdout.write("release surface verified\n");
}
