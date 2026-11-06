-- Agent Workbench schema v1. All timestamps are UTC epoch milliseconds.
-- Production: SQLite >= 3.51.3; local filesystem only; one daemon owns writes.
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE config_versions (
  digest TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('global','policy','check_plan','instructions','environment')),
  json TEXT NOT NULL CHECK(json_valid(json)),
  trusted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL UNIQUE,
  managed_git_dir TEXT NOT NULL UNIQUE,
  source_base_ref TEXT NOT NULL,
  source_base_sha TEXT NOT NULL,
  integration_ref TEXT NOT NULL,
  integration_sha TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_digest TEXT NOT NULL REFERENCES config_versions(digest),
  created_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('draft','ready','allocating','running','waiting_human','freezing','verifying','reviewing',
     'changes_required','awaiting_approval','integrating','integrated','cancelled','failed','recovery_required')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL REFERENCES config_versions(digest),
  active_candidate_id TEXT REFERENCES candidates(id),
  blocked_json TEXT CHECK(blocked_json IS NULL OR json_valid(blocked_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_by_state ON tasks(state, updated_at_ms);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  dependency_id TEXT NOT NULL REFERENCES tasks(id),
  required_candidate_sha TEXT,
  PRIMARY KEY(task_id, dependency_id),
  CHECK(task_id <> dependency_id)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  task_id TEXT REFERENCES tasks(id),
  role TEXT NOT NULL CHECK(role IN ('writer','check','review','board','experiment')),
  path TEXT NOT NULL UNIQUE,
  branch_ref TEXT UNIQUE,
  base_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','creating','ready','frozen','quarantined','removed')),
  created_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  workspace_id TEXT REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK(role IN ('implement','check','review','board','handoff')),
  generation INTEGER NOT NULL CHECK(generation > 0),
  driver TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  state TEXT NOT NULL CHECK(state IN
    ('created','starting','running','waiting_input','stopping','completed','failed','cancelled','unknown')),
  writes_workspace INTEGER NOT NULL CHECK(writes_workspace IN (0,1)),
  worker_instance_id TEXT,
  worker_socket TEXT,
  native_session_id TEXT,
  native_turn_id TEXT,
  presentation_json TEXT CHECK(presentation_json IS NULL OR json_valid(presentation_json)),
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  deadline_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json))
) STRICT;
CREATE UNIQUE INDEX one_active_writer ON attempts(workspace_id)
WHERE writes_workspace = 1 AND state IN ('created','starting','running','waiting_input','stopping','unknown');

CREATE TABLE leases (
  resource TEXT PRIMARY KEY,
  owner_attempt_id TEXT REFERENCES attempts(id),
  owner_instance_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  heartbeat_at_ms INTEGER NOT NULL,
  observed_expiry_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','recovery_required','released'))
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','worker','system')),
  actor_id TEXT NOT NULL,
  method TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  params_digest TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  expected_version INTEGER,
  state TEXT NOT NULL CHECK(state IN ('pending','executing','completed','failed','uncertain')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX commands_pending ON commands(state, created_at_ms);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  attempt_id TEXT REFERENCES attempts(id),
  source_seq INTEGER,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(attempt_id, source_seq)
) STRICT;
CREATE INDEX events_by_aggregate ON events(aggregate_id, seq);

CREATE TABLE worker_offsets (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  accepted_source_seq INTEGER NOT NULL DEFAULT 0 CHECK(accepted_source_seq >= 0),
  worker_instance_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE artifacts (
  digest TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE artifact_links (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES artifacts(digest),
  PRIMARY KEY(owner_type, owner_id, purpose, digest)
) STRICT;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL CHECK(generation > 0),
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  identity_digest TEXT NOT NULL UNIQUE,
  base_sha TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  check_plan_digest TEXT NOT NULL REFERENCES config_versions(digest),
  manifest_digest TEXT NOT NULL REFERENCES artifacts(digest),
  state TEXT NOT NULL CHECK(state IN ('frozen','stale','integrated','rejected')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(task_id, generation)
) STRICT;

CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  check_key TEXT NOT NULL,
  execution_number INTEGER NOT NULL CHECK(execution_number > 0),
  attempt_id TEXT REFERENCES attempts(id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','passed','failed','timed_out','cancelled','unknown')),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  command_digest TEXT NOT NULL,
  environment_digest TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0,1)),
  output_digest TEXT REFERENCES artifacts(digest),
  result_digest TEXT REFERENCES artifacts(digest),
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  UNIQUE(candidate_id, check_key, execution_number)
) STRICT;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  attempt_id TEXT REFERENCES attempts(id),
  profile_id TEXT NOT NULL,
  execution_number INTEGER NOT NULL DEFAULT 1 CHECK(execution_number > 0),
  provider_id TEXT NOT NULL,
  training_family TEXT NOT NULL,
  model_id TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  output_digest TEXT REFERENCES artifacts(digest),
  state TEXT NOT NULL CHECK(state IN ('queued','running','valid','invalid','failed','incomplete')),
  verdict TEXT CHECK(verdict IN ('pass','request_changes','insufficient_evidence')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(candidate_id, profile_id, execution_number)
) STRICT;

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  local_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('blocker','high','medium','low')),
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  UNIQUE(review_id, local_key)
) STRICT;

CREATE TABLE finding_dispositions (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  disposition_version INTEGER NOT NULL CHECK(disposition_version > 0),
  disposition TEXT NOT NULL CHECK(disposition IN ('open','confirmed','false_positive','risk_accepted')),
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','independent_reviewer','system')),
  actor_id TEXT NOT NULL,
  evidence_digest TEXT REFERENCES artifacts(digest),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(finding_id, disposition_version)
) STRICT;
CREATE INDEX finding_dispositions_history ON finding_dispositions(finding_id, disposition_version);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  action TEXT NOT NULL CHECK(action IN ('integrate','publish','risk_accept')),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  binding_digest TEXT NOT NULL UNIQUE,
  evidence_digest TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','granted','denied','revoked','expired','consumed')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id),
  human_actor_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL,
  consumed_by_command_id TEXT UNIQUE REFERENCES commands(id),
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
  target_ref TEXT NOT NULL,
  expected_old_sha TEXT NOT NULL,
  new_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','applied','failed','uncertain')),
  created_at_ms INTEGER NOT NULL,
  confirmed_at_ms INTEGER
) STRICT;

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repositories(id),
  charter_json TEXT NOT NULL CHECK(json_valid(charter_json)),
  charter_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('created','blind_collect','debating','auditing','synthesizing','completed','failed','cancelled')),
  current_round INTEGER NOT NULL DEFAULT 0 CHECK(current_round >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  memo_digest TEXT REFERENCES artifacts(digest),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE board_seats (
  board_id TEXT NOT NULL REFERENCES boards(id),
  seat_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  training_family TEXT NOT NULL,
  native_session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','failed','withdrawn','finished')),
  PRIMARY KEY(board_id, seat_id)
) STRICT;

CREATE TABLE board_rounds (
  board_id TEXT NOT NULL REFERENCES boards(id),
  round_number INTEGER NOT NULL CHECK(round_number >= 0),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('collecting','sealed','aborted')),
  expected_seats_json TEXT NOT NULL CHECK(json_valid(expected_seats_json)),
  input_manifest_digest TEXT REFERENCES artifacts(digest),
  seal_digest TEXT REFERENCES artifacts(digest),
  deadline_at_ms INTEGER NOT NULL,
  sealed_at_ms INTEGER,
  PRIMARY KEY(board_id, round_number)
) STRICT;

CREATE TABLE board_posts (
  board_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  seat_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  output_digest TEXT NOT NULL REFERENCES artifacts(digest),
  accepted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(board_id, round_number, seat_id),
  FOREIGN KEY(board_id, round_number) REFERENCES board_rounds(board_id, round_number),
  FOREIGN KEY(board_id, seat_id) REFERENCES board_seats(board_id, seat_id)
) STRICT;

CREATE TABLE board_access_grants (
  board_id TEXT NOT NULL REFERENCES boards(id),
  seat_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  artifact_digest TEXT NOT NULL REFERENCES artifacts(digest),
  granted_at_ms INTEGER NOT NULL,
  PRIMARY KEY(board_id, seat_id, round_number, artifact_digest),
  FOREIGN KEY(board_id, seat_id) REFERENCES board_seats(board_id, seat_id)
) STRICT;

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  target_attempt_id TEXT REFERENCES attempts(id),
  cutoff_event_seq INTEGER NOT NULL CHECK(cutoff_event_seq >= 0),
  output_digest TEXT NOT NULL REFERENCES artifacts(digest),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
CREATE TRIGGER candidates_identity_immutable BEFORE UPDATE OF
  identity_json, identity_digest, candidate_sha, tree_sha, base_sha,
  check_plan_digest, manifest_digest ON candidates
BEGIN SELECT RAISE(ABORT, 'candidate identity is immutable'); END;
