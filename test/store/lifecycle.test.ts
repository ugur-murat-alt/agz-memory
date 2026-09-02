import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { doctorDatabase } from "../../src/admin/doctor";
import { MemoryStore } from "../../src/store";

describe("note lifecycle", () => {
  test("records idempotent revisions and durable derived-index outbox operations", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-lifecycle-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const store = new MemoryStore(opened.db, ["fake@1"]);
    const projectID = store.createProject("Lifecycle").project!.projectID;
    const noteID = store.update(projectID, {
      kind: "fact",
      title: "one",
      summary: "one",
      content: "one",
    }).id!;
    expect(revisions(opened.db, noteID)).toBe(1);
    store.update(projectID, { id: noteID, title: "one" });
    expect(revisions(opened.db, noteID)).toBe(1);
    store.update(projectID, { id: noteID, title: "two" });
    expect(revisions(opened.db, noteID)).toBe(2);
    store.pin(projectID, noteID, true);
    store.pin(projectID, noteID, true);
    expect(revisions(opened.db, noteID)).toBe(3);
    expect(
      (
        opened.db.query("SELECT current_revision FROM notes WHERE id = ?").get(noteID) as {
          current_revision: number;
        }
      ).current_revision,
    ).toBe(3);
    expect(
      (opened.db.query("SELECT COUNT(*) AS count FROM index_outbox").get() as { count: number }).count,
    ).toBe(3);

    store.update(projectID, { id: noteID, delete: true });
    expect(revisions(opened.db, noteID)).toBe(0);
    expect(
      (
        opened.db
          .query("SELECT COUNT(*) AS count FROM index_outbox WHERE operation = 'delete-note'")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    store.deleteProject(projectID, "Lifecycle");
    expect(
      (
        opened.db
          .query("SELECT COUNT(*) AS count FROM index_outbox WHERE operation = 'purge-project'")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    const report = doctorDatabase(opened.db);
    expect(report.ok).toBe(true);
    expect(report.failures).not.toContain("orphanedOutboxProjects");
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

function revisions(db: import("bun:sqlite").Database, noteID: string): number {
  return (
    db.query("SELECT COUNT(*) AS count FROM note_revisions WHERE note_id = ?").get(noteID) as {
      count: number;
    }
  ).count;
}
