import type { Database } from "bun:sqlite";

const KEYED_VERSION = /^redaction\/1;quarantine-key=([0-9a-f]{24});quarantine-digest=2$/;
const UNAVAILABLE_VERSION = /^redaction\/1;quarantine-key=unavailable;quarantine-digest=2$/;

/** Content-free input for a future V12 quarantine migration decision. */
export function quarantinePrivacyReport(db: Database): {
  quarantinedEvents: number;
  keyedEvents: number;
  unavailableKeyEvents: number;
  legacyOrUnknownEvents: number;
  keyIDs: string[];
  digest: {
    algorithm: "HMAC-SHA256";
    input: "quarantine-source-identity-and-redacted-payload/2";
    storage: "capture_events.payload_hash";
    keyID: "capture_events.redaction_version quarantine-key suffix";
  };
} {
  const rows = db
    .query(
      `SELECT redaction_version, COUNT(*) AS count
         FROM capture_events
        WHERE state = 'quarantined'
        GROUP BY redaction_version`,
    )
    .all() as Array<{ redaction_version: string; count: number }>;
  let quarantinedEvents = 0;
  let keyedEvents = 0;
  let unavailableKeyEvents = 0;
  let legacyOrUnknownEvents = 0;
  const keyIDs = new Set<string>();
  for (const row of rows) {
    quarantinedEvents += row.count;
    const keyed = KEYED_VERSION.exec(row.redaction_version);
    if (keyed) {
      keyedEvents += row.count;
      keyIDs.add(keyed[1]!);
    } else if (UNAVAILABLE_VERSION.test(row.redaction_version)) {
      unavailableKeyEvents += row.count;
    } else {
      legacyOrUnknownEvents += row.count;
    }
  }
  return {
    quarantinedEvents,
    keyedEvents,
    unavailableKeyEvents,
    legacyOrUnknownEvents,
    keyIDs: [...keyIDs].sort(),
    digest: {
      algorithm: "HMAC-SHA256",
      input: "quarantine-source-identity-and-redacted-payload/2",
      storage: "capture_events.payload_hash",
      keyID: "capture_events.redaction_version quarantine-key suffix",
    },
  };
}
