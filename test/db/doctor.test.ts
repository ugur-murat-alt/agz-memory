import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { doctorDatabase } from "../../src/admin/doctor";
import { openMemoryDatabase } from "../../src/db";
import { noteContentHash } from "../../src/hash";
import { MemoryStore } from "../../src/store";

describe("deep database doctor", () => {
  test("detects canonical hashes, current revision drift, and revision gaps", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-doctor-deep-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const store = new MemoryStore(opened.db);
      const projectID = store.createProject("Doctor").project!.projectID;
      const noteID = store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "first",
        summary: "first",
      }).id!;
      store.update(projectID, { operation: "patch", id: noteID, changes: { summary: "second" } });
      store.update(projectID, { operation: "patch", id: noteID, changes: { summary: "third" } });
      expect(doctorDatabase(opened.db)).toMatchObject({
        ok: true,
        invariants: {
          noteContentHashMismatches: 0,
          revisionContentHashMismatches: 0,
          currentRevisionMismatches: 0,
          revisionGaps: 0,
        },
      });

      opened.db.query("UPDATE notes SET content_hash = ? WHERE project_id = ? AND id = ?")
        .run("a".repeat(64), projectID, noteID);
      expect(doctorDatabase(opened.db).failures).toContain("noteContentHashMismatches");
      opened.db.query("UPDATE notes SET content_hash = ? WHERE project_id = ? AND id = ?")
        .run(noteContentHash("fact", "first", "third", ""), projectID, noteID);

      opened.db.query(
        "UPDATE note_revisions SET content_hash = ? WHERE project_id = ? AND note_id = ? AND revision = 1",
      ).run("b".repeat(64), projectID, noteID);
      expect(doctorDatabase(opened.db).failures).toContain("revisionContentHashMismatches");
      opened.db.query(
        "UPDATE note_revisions SET content_hash = ? WHERE project_id = ? AND note_id = ? AND revision = 1",
      ).run(noteContentHash("fact", "first", "first", ""), projectID, noteID);

      opened.db.query(
        "UPDATE note_revisions SET pinned = 1 WHERE project_id = ? AND note_id = ? AND revision = 3",
      ).run(projectID, noteID);
      expect(doctorDatabase(opened.db).failures).toContain("currentRevisionMismatches");
      opened.db.query(
        "UPDATE note_revisions SET pinned = 0 WHERE project_id = ? AND note_id = ? AND revision = 3",
      ).run(projectID, noteID);

      opened.db.query(
        "DELETE FROM note_revisions WHERE project_id = ? AND note_id = ? AND revision = 2",
      ).run(projectID, noteID);
      expect(doctorDatabase(opened.db).failures).toContain("revisionGaps");
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
