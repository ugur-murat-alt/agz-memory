import { resolve } from "path";
import { readFileSync } from "fs";

const CORE_PACKAGE = "@vaur94/agz-memory";
const PLUGIN_PACKAGE = "@vaur94/agz-memory-plugin";
const RETIRED_NAME = ["opencode", "2", "-memory"].join("");
const RETIRED_VERSION = ["0.4.0", "beta.1"].join("-");

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
    files.set(path, readFileSync(resolve(root, path), "utf8"));
  }
  return files;
}

export function validateReleaseFiles(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  const required = [
    "README.md",
    "README.tr.md",
    "ARCHITECTURE.md",
    "CHANGELOG.md",
    "docs/backup-restore-runbook.md",
    "docs/backup-restore-runbook.tr.md",
    "packages/opencode-plugin/README.md",
    "packages/opencode-plugin/README.tr.md",
  ];
  for (const path of required) {
    if (!files.has(path)) errors.push(`missing required release file: ${path}`);
  }

  for (const [path, content] of files) {
    if (content.includes(RETIRED_NAME)) errors.push(`${path}: contains retired project name`);
    if (path !== "CHANGELOG.md" && content.includes(RETIRED_VERSION)) {
      errors.push(`${path}: contains retired package version`);
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
  if (version && version !== "0.4.1") errors.push(`final package version must be 0.4.1, found ${version}`);

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
    requireText(files, "CHANGELOG.md", `## [${version}] - `, errors);
  }
  requireText(files, "src/types.ts", "SCHEMA_VERSION = 10", errors);
  requireText(files, "README.md", "| SQLite schema | `10` |", errors);
  requireText(files, "README.tr.md", "| SQLite schema | `10` |", errors);

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
  const pluginFiles = Array.isArray(pluginPackage?.files) ? pluginPackage.files : [];
  if (!pluginFiles.includes("README.tr.md")) {
    errors.push("plugin package files must include README.tr.md");
  }
  return errors;
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
