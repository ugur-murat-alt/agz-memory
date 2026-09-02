CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('decision','fact','procedure','context','research','preference','task')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  size_class TEXT NOT NULL CHECK (size_class IN ('inline','indexed')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
  supersedes_id TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  subject_key TEXT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, id)
);
CREATE INDEX notes_project_idx ON notes(project_id, status);
CREATE UNIQUE INDEX notes_active_subject_idx
  ON notes(project_id, kind, subject_key)
  WHERE status = 'active' AND subject_key IS NOT NULL;
CREATE TABLE note_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  predicate TEXT NOT NULL CHECK (predicate IN ('SUPPORTS','DERIVED_FROM','PART_OF','ABOUT','PRECEDES','SUPERSEDES')),
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, source_id, target_id, predicate),
  FOREIGN KEY (project_id, source_id) REFERENCES notes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_id) REFERENCES notes(project_id, id) ON DELETE CASCADE
);
CREATE INDEX note_edges_source_idx ON note_edges(project_id, source_id);
CREATE INDEX note_edges_target_idx ON note_edges(project_id, target_id);
CREATE TABLE project_bindings (
  binding_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source = 'opencode-v2'),
  source_project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  canonical_path_hash TEXT NOT NULL CHECK (length(canonical_path_hash) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source, source_project_id, workspace_id)
);
CREATE TABLE capture_checkpoints (
  session_id TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL REFERENCES project_bindings(binding_key) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('active','idle','unavailable','closed')),
  last_message_id TEXT,
  last_reconciled_at INTEGER,
  next_reconcile_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX capture_checkpoints_due_idx
  ON capture_checkpoints(state, next_reconcile_at);
CREATE TABLE capture_events (
  idempotency_key TEXT PRIMARY KEY,
  contract TEXT NOT NULL CHECK (contract = 'agz-memory.capture/1'),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  binding_key TEXT NOT NULL REFERENCES project_bindings(binding_key) ON DELETE CASCADE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('user-candidate','assistant-candidate','session-summary','tool-signal')),
  source_session_id TEXT NOT NULL,
  source_message_id TEXT,
  source_ordinal INTEGER CHECK (source_ordinal IS NULL OR source_ordinal >= 0),
  source_tool_call_id TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  payload_hash TEXT,
  redaction_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','shadowed','review','materialized','duplicate','ignored','rejected','quarantined','failed','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  note_id TEXT,
  last_error_code TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX capture_events_state_idx ON capture_events(state, updated_at);
CREATE INDEX capture_events_session_idx ON capture_events(project_id, source_session_id);
CREATE INDEX capture_events_note_idx ON capture_events(project_id, note_id);
CREATE TABLE note_provenance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('mcp-manual','opencode-capture','migration','legacy-import','admin')),
  capture_event_id TEXT,
  source_session_id TEXT,
  source_message_id TEXT,
  source_ordinal INTEGER,
  source_tool_call_id TEXT,
  redaction_version TEXT,
  extractor_version TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY (project_id, note_id) REFERENCES notes(project_id, id) ON DELETE CASCADE
);
CREATE TABLE note_revisions (
  project_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  size_class TEXT NOT NULL,
  pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','archived')),
  supersedes_id TEXT,
  subject_key TEXT,
  content_hash TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, note_id, revision),
  FOREIGN KEY (project_id, note_id) REFERENCES notes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, provenance_id) REFERENCES note_provenance(project_id, id)
);
CREATE TABLE index_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backend TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert-note','delete-note','purge-project')),
  project_id TEXT NOT NULL,
  note_id TEXT,
  revision INTEGER,
  content_hash TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','succeeded','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(backend, operation, project_id, note_id, revision)
);
CREATE INDEX index_outbox_due_idx
  ON index_outbox(backend, project_id, state, available_at, id);
CREATE TABLE schema_state (version INTEGER PRIMARY KEY);
INSERT INTO schema_state(version) VALUES (10);
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, summary, content,
  content='notes', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, summary, content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, summary, content)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content);
  INSERT INTO notes_fts(rowid, title, summary, content)
  VALUES (new.rowid, new.title, new.summary, new.content);
END;
