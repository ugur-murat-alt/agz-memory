import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeTestEvidence } from "../../scripts/collect-test-evidence";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function makeEvidenceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-evidence-"));
  temporaryRoots.push(directory);
  mkdirSync(join(directory, "coverage"), { recursive: true });
  writeFileSync(join(directory, "junit.xml"), "<testsuite/>");
  writeFileSync(join(directory, "coverage", "lcov.info"), "secret canary must not be read");
  return directory;
}

describe("CI test evidence", () => {
  test("writes commit-bound metadata without copying test payloads", () => {
    const directory = makeEvidenceDirectory();
    const manifestPath = join(directory, "manifest.json");

    const manifest = writeTestEvidence(manifestPath, {
      sha: "abc123",
      bun: "1.3.14",
      platform: "linux",
      suiteStatus: "success",
      timingStatus: "success",
    });

    expect(manifest.status).toBe("success");
    expect(manifest.sha).toBe("abc123");
    expect(manifest.command).toContain("bun scripts/run-tests.ts");
    expect(manifest.artifacts.find(({ name }) => name === "junit")?.present).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(directory);
    expect(readFileSync(manifestPath, "utf8")).not.toContain("secret canary");
    expect(existsSync(join(directory, "failure.json"))).toBe(false);
  });

  test("records a failed command and never turns cancellation into success", () => {
    const directory = makeEvidenceDirectory();

    const manifest = writeTestEvidence(join(directory, "manifest.json"), {
      sha: "def456",
      bun: "1.3.14",
      platform: "linux",
      suiteStatus: "cancelled",
      timingStatus: "success",
    });

    expect(manifest.status).toBe("cancelled");
    expect(readFileSync(join(directory, "failure.json"), "utf8")).toContain('"status":"cancelled"');
    expect(manifest.artifacts.find(({ name }) => name === "failure")?.present).toBe(true);
  });
});
