import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

export type EvidenceStatus = "success" | "failure" | "cancelled" | "skipped" | "unknown";

export type TestEvidenceOptions = {
  sha: string;
  bun: string;
  platform: string;
  suiteStatus: EvidenceStatus;
  timingStatus?: EvidenceStatus;
  timingRequired?: boolean;
};

export type TestEvidenceManifest = {
  schemaVersion: 1;
  sha: string;
  bun: string;
  platform: string;
  command: string;
  status: EvidenceStatus;
  commands: Array<{ name: string; command: string; status: EvidenceStatus }>;
  artifacts: Array<{ name: string; file: string; present: boolean }>;
};

const SUITE_COMMAND =
  "bun scripts/run-tests.ts --coverage --coverage-reporter=lcov --reporter=junit";
const TIMING_COMMAND =
  "bun scripts/run-migration-timing.ts --iterations 10 --assert-p95";
const ARTIFACTS = [
  ["junit", "junit.xml"],
  ["coverage-lcov", "coverage/lcov.info"],
  ["migration-timing", "migration-timing.json"],
  ["failure-timing", "failure-timing.json"],
  ["failure", "failure.json"],
] as const;

const allowedStatuses = new Set<EvidenceStatus>([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "unknown",
]);

function normalizeStatus(status: string | undefined): EvidenceStatus {
  return allowedStatuses.has(status as EvidenceStatus)
    ? (status as EvidenceStatus)
    : "unknown";
}

function aggregateStatus(commands: readonly { status: EvidenceStatus }[]): EvidenceStatus {
  if (commands.some(({ status }) => status === "failure")) return "failure";
  if (commands.some(({ status }) => status === "cancelled")) return "cancelled";
  if (commands.some(({ status }) => status === "skipped")) return "skipped";
  if (commands.some(({ status }) => status === "unknown")) return "unknown";
  return "success";
}

function assertOutputInsideDirectory(outputPath: string, directory: string): void {
  const outputRelative = relative(directory, outputPath);
  if (
    !outputRelative ||
    outputRelative === ".." ||
    outputRelative.startsWith(`..${"/"}`) ||
    outputRelative.startsWith(`..${"\\"}`)
  ) {
    throw new Error("evidence manifest must be inside its evidence directory");
  }
}

export function createTestEvidence(
  directory: string,
  options: TestEvidenceOptions,
): TestEvidenceManifest {
  const timingRequired = options.timingRequired ?? true;
  const commands: TestEvidenceManifest["commands"] = [
    {
      name: "test-suite",
      command: SUITE_COMMAND,
      status: normalizeStatus(options.suiteStatus),
    },
  ];
  if (timingRequired) {
    commands.push({
      name: "migration-timing",
      command: TIMING_COMMAND,
      status: normalizeStatus(options.timingStatus),
    });
  }

  const status = aggregateStatus(commands);
  if (status !== "success") {
    // This file intentionally contains only status metadata. It must never copy
    // test output, source text, paths, or environment values into an artifact.
    writeFileSync(
      join(directory, "failure.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sha: options.sha,
        bun: options.bun,
        platform: options.platform,
        status,
        failedCommands: commands
          .filter(({ status: commandStatus }) => commandStatus !== "success")
          .map(({ name, status: commandStatus }) => ({ name, status: commandStatus })),
      })}\n`,
      { mode: 0o600 },
    );
  }

  return {
    schemaVersion: 1,
    sha: options.sha,
    bun: options.bun,
    platform: options.platform,
    command: commands.map(({ command }) => command).join(" && "),
    status,
    commands,
    artifacts: ARTIFACTS.map(([name, file]) => ({
      name,
      file,
      present: existsSync(join(directory, file)),
    })),
  };
}

export function writeTestEvidence(
  outputPath: string,
  options: TestEvidenceOptions,
): TestEvidenceManifest {
  const resolvedOutput = resolve(outputPath);
  const directory = dirname(resolvedOutput);
  mkdirSync(directory, { recursive: true });
  assertOutputInsideDirectory(resolvedOutput, directory);
  const manifest = createTestEvidence(directory, options);
  writeFileSync(resolvedOutput, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function runTestEvidenceCLI(args: readonly string[] = process.argv.slice(2)): number {
  try {
    const outputPath = readOption(args, "--output");
    if (!outputPath) throw new Error("usage: --output PATH");
    const manifest = writeTestEvidence(outputPath, {
      sha: process.env.EVIDENCE_SHA ?? process.env.GITHUB_SHA ?? "local",
      bun: Bun.version,
      platform: process.platform,
      suiteStatus: normalizeStatus(process.env.TEST_SUITE_STATUS),
      timingStatus: normalizeStatus(process.env.MIGRATION_TIMING_STATUS),
      timingRequired: process.env.MIGRATION_TIMING_REQUIRED !== "false",
    });
    process.stdout.write(`test evidence manifest ${manifest.status}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`test evidence: ${error instanceof Error ? error.message : "failed"}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(runTestEvidenceCLI());
