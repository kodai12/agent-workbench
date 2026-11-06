import {
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  Actor,
  Json,
  Digest,
  WorkspaceRecord,
  CheckResult,
  ApprovalBinding,
} from "../../contracts/ports.js";
import { openStore } from "../adapters/sqlite/store.js";
import { createGitService } from "../adapters/git/index.js";
import { createGitRunner } from "../adapters/git/runner.js";
import { registeredArtifacts } from "./artifacts.js";
import { readConfig, saveConfig } from "./config.js";
import {
  object,
  text,
  number,
  list,
  strings,
  record,
  decode,
  requiredKeys,
  type ObjectValue,
} from "./data.js";
import {
  type RepoRow,
  type TaskRow,
  type AttemptRow,
  type CandidateRow,
  type WorkspaceRow,
  type CommandRequest,
} from "./types.js";
import {
  socketPathFor,
  prepareSocketDirectory,
  processStartIdentity,
} from "../daemon/lifecycle.js";
import { validateWorkerEventData } from "../domain/worker-event.js";
import { buildCheckPlan } from "../domain/check-plan.js";
import {
  id,
  atomicWrite,
  privateDirectory,
  childEnvironment,
  executable,
} from "../adapters/os/paths.js";
import { unwrap, asError } from "../domain/errors.js";
import { digest, canonical, bytesDigest } from "../domain/canonical.js";
import { reduceTask, type TaskFacts } from "../domain/task.js";
import {
  evaluateGate,
  type GateReview,
  type GateInput,
  validateApproval,
} from "../domain/gate.js";
import {
  validateReview,
  type SourceEvidence,
  type FindingDisposition,
  validateDisposition,
  makeReviewPacket,
} from "../domain/review.js";
import { validateContract, parseJson, contracts } from "../contracts/loader.js";
import {
  backupStore,
  planWorkspaceGc,
  planObjectGc,
} from "../adapters/sqlite/operations.js";
import { createBoardService } from "./board-service.js";
import { controlWorker } from "./worker-control.js";
import { createHandoffService } from "./handoff-service.js";

const privileged = [
  "policy.trust",
  "approval.grant",
  "approval.deny",
  "task.integrate",
  "finding.disposition",
];
const knownParams: Record<string, string[]> = {
  "repo.add": ["sourcePath", "name", "baseRef"],
  "repo.list": [],
  "repo.get": ["repoId"],
  "repo.syncPlan": ["repoId"],
  "policy.import": ["repoId", "policy"],
  "policy.trust": ["repoId", "expectDigest"],
  "profiles.configure": ["profiles"],
  "task.create": ["repoId", "spec"],
  "task.start": ["taskId", "interaction", "presentation"],
  "task.get": ["taskId"],
  "task.logs": ["taskId", "afterSeq"],
  "task.list": [],
  "task.verify": ["taskId", "rerun"],
  "task.review": ["taskId", "rerun"],
  "task.finish": ["taskId"],
  "task.cancel": ["taskId", "reason"],
  "task.revise": ["taskId", "spec"],
  "task.recover": ["taskId", "planDigest"],
  "task.send": ["taskId", "message"],
  "task.integrate": ["taskId", "approvalId"],
  "task.export": ["taskId", "format", "out"],
  "events.subscribe": ["taskId", "afterSeq"],
  "approval.request": ["taskId", "action"],
  "approval.get": ["requestId", "approvalId"],
  "approval.grant": ["requestId", "expectDigest"],
  "approval.deny": ["requestId", "expectDigest"],
  "findings.list": ["candidateId"],
  "findings.get": ["findingId"],
  "finding.disposition": [
    "findingId",
    "disposition",
    "reason",
    "evidenceDigest",
  ],
  "board.create": ["charter", "repoId"],
  "board.start": ["boardId"],
  "board.get": ["boardId"],
  "board.memo": ["boardId"],
  "board.cancel": ["boardId", "reason"],
  "handoff.create": ["taskId", "goal"],
  "history.query": ["taskId", "question", "scope"],
  "gc.plan": [],
  "backup.create": ["destination"],
  "system.doctor": [],
};
const readMethods = new Set([
  "repo.list",
  "repo.get",
  "repo.syncPlan",
  "task.get",
  "task.logs",
  "task.list",
  "approval.get",
  "findings.list",
  "findings.get",
  "board.get",
  "board.memo",
  "history.query",
  "gc.plan",
  "system.doctor",
  "events.subscribe",
]);
const creates = new Set([
  "repo.add",
  "policy.import",
  "profiles.configure",
  "task.create",
  "board.create",
  "handoff.create",
  "backup.create",
]);
const mark = (condition: boolean, code: string, message: string): void => {
  if (!condition) throw { code, message };
};
const jsonError = (error: unknown): Json => ({ ...asError(error) });
const toDigest = (value: string): Digest => {
  if (!/^sha256:[0-9a-f]{64}$/.test(value))
    throw { code: "INVALID_INPUT", message: "digestが不正です" };
  return value as Digest;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return false;
    throw error;
  }
};

export function createWorkbench(home: string) {
  const store = unwrap(openStore(home)),
    db = store.db,
    artifacts = registeredArtifacts(store);
  const git = createGitService(home, undefined, executable("git")),
    gitRun = createGitRunner(home, executable("git"));
  const processes = new Map<string, ChildProcess>(),
    locks = new Map<string, Promise<void>>();
  let reconciling = false;
  const acquireMutation = async (): Promise<() => void> => {
    const prior = locks.get("mutations") ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    locks.set(
      "mutations",
      prior.then(() => held),
    );
    await prior;
    return release;
  };
  db.prepare(
    "UPDATE commands SET state='uncertain',updated_at_ms=? WHERE state IN ('pending','executing')",
  ).run(Date.now());
  const getRepo = (key: string): RepoRow => {
    const row = db
      .prepare("SELECT * FROM repositories WHERE id=? OR name=?")
      .get(key, key) as RepoRow | undefined;
    if (!row) throw { code: "NOT_FOUND", message: "repositoryがありません" };
    return row;
  };
  const getTask = (key: string): TaskRow => {
    const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(key) as
      | TaskRow
      | undefined;
    if (!row) throw { code: "NOT_FOUND", message: "taskがありません" };
    return row;
  };
  const getCandidate = (task: TaskRow): CandidateRow => {
    const row = db
      .prepare("SELECT * FROM candidates WHERE id=?")
      .get(task.active_candidate_id) as CandidateRow | undefined;
    if (!row) throw { code: "CANDIDATE_REQUIRED", message: "候補がありません" };
    return row;
  };
  const getPolicy = (repo: RepoRow): ObjectValue => {
    const value = db
      .prepare("SELECT json,trusted_at_ms FROM config_versions WHERE digest=?")
      .get(repo.policy_digest) as
      | { json: string; trusted_at_ms: number | null }
      | undefined;
    mark(
      !!value?.trusted_at_ms,
      "POLICY_UNTRUSTED",
      "policyの明示trustが必要です",
    );
    return object(
      unwrap(validateContract("project-policy", decode(value!.json))),
    );
  };
  const configVersion = (
    kind: string,
    value: Json,
    trusted = false,
  ): Digest => {
    const hash = digest(value);
    db.prepare(
      "INSERT INTO config_versions(digest,kind,json,trusted_at_ms,created_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(digest) DO NOTHING",
    ).run(
      hash,
      kind,
      canonical(value),
      trusted ? Date.now() : null,
      Date.now(),
    );
    return hash;
  };
  const saveArtifact = async (
    value: Json | string,
    purpose = "application/json",
  ) =>
    unwrap(
      await artifacts.put(
        Buffer.from(typeof value === "string" ? value : canonical(value)),
        purpose,
        64 * 1024 * 1024,
      ),
    );
  const artifactJson = async (hash: Digest): Promise<Json> =>
    unwrap(
      parseJson(
        Buffer.from(unwrap(await artifacts.readVerified(hash))).toString(
          "utf8",
        ),
      ),
    );
  const event = (
    taskId: string,
    type: string,
    payload: Json,
    actor: Actor = { kind: "system", id: "daemon" },
  ): void => {
    const task = getTask(taskId);
    unwrap(store.appendEvent(taskId, task.version, type, payload, actor));
  };
  const transition = (
    taskId: string,
    type: string,
    facts: TaskFacts,
    payload: Json = {},
  ): void => {
    store.transact(() => {
      const task = getTask(taskId),
        state = unwrap(reduceTask(task.state, type, facts));
      db.prepare("UPDATE tasks SET state=? WHERE id=?").run(state, taskId);
      event(taskId, type, payload);
    });
  };
  const workRecord = (row: WorkspaceRow): WorkspaceRecord => ({
    id: row.id,
    taskId: row.task_id,
    path: row.path,
    branchRef: row.branch_ref,
    baseSha: row.base_sha,
    role: row.role,
  });
  const workspace = async (
    task: TaskRow,
    role: WorkspaceRow["role"],
    base: string,
  ): Promise<WorkspaceRow> => {
    const wid = id("wsp"),
      path = join(home, "workspaces", task.repo_id, wid),
      branch =
        role === "writer"
          ? `refs/heads/aw/tasks/${task.id}/${task.generation}`
          : null;
    db.prepare(
      "INSERT INTO workspaces(id,repo_id,task_id,role,path,branch_ref,base_sha,state,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      wid,
      task.repo_id,
      task.id,
      role,
      path,
      branch,
      base,
      "reserved",
      Date.now(),
    );
    const row: WorkspaceRow = {
      id: wid,
      repo_id: task.repo_id,
      task_id: task.id,
      role,
      path,
      branch_ref: branch,
      base_sha: base,
      state: "reserved",
    };
    unwrap(
      await git.forRepository(task.repo_id).createWorkspace(workRecord(row)),
    );
    db.prepare("UPDATE workspaces SET state='ready' WHERE id=?").run(wid);
    return { ...row, state: "ready" };
  };
  const profile = (name: string): ObjectValue => {
    const value = readConfig(home).profiles[name];
    if (!value)
      throw {
        code: "PROFILE_UNAVAILABLE",
        message: "profileが未設定です: " + name,
      };
    return object(unwrap(validateContract("model-profile", value)));
  };
  const knownFixture = (repo: RepoRow): boolean => {
    if (!readConfig(home).devFixtures) return false;
    try {
      const expected = record(
        readFileSync(join(home, "fixtures", "identity.json"), "utf8"),
      );
      return (
        repo.source_path === expected.sourcePath &&
        repo.source_base_sha === expected.baseSha &&
        repo.source_path === realpathSync(join(home, "fixtures", "demo"))
      );
    } catch {
      return false;
    }
  };
  const invalidate = (taskId: string): void => {
    db.prepare(
      "UPDATE approval_requests SET state='revoked' WHERE task_id=? AND state IN ('pending','granted')",
    ).run(taskId);
    db.prepare(
      "UPDATE approvals SET revoked_at_ms=? WHERE request_id IN (SELECT id FROM approval_requests WHERE task_id=?) AND consumed_by_command_id IS NULL",
    ).run(Date.now(), taskId);
  };
  const environment = (task: TaskRow): Json => {
    const spec = record(task.spec_json);
    return {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      profiles: [
        text(spec.implementerProfile),
        ...strings(spec.reviewerProfiles),
      ].map((name) => ({ name, profile: profile(name) })),
      simulated: knownFixture(getRepo(task.repo_id)),
    };
  };
  return {
    store,
    artifacts,
    dispatch,
    reconcile,
    close: () => store.close(),
    gateFor,
    events: (after: number, aggregateId?: string): Json[] => {
      const rows = aggregateId
        ? db
            .prepare(
              "SELECT * FROM events WHERE seq>? AND aggregate_id=? ORDER BY seq LIMIT 1000",
            )
            .all(after, aggregateId)
        : db
            .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 1000")
            .all(after);
      return rows as Json[];
    },
  };
  async function gateFor(_taskId:string):Promise<ReturnType<typeof evaluateGate>> {throw {code:'UNSUPPORTED_OPERATION',message:'gateは後続の接続段で追加します'};}
  async function dispatch(_request:CommandRequest,_actor:Actor):Promise<Json> {throw {code:'UNSUPPORTED_OPERATION',message:'commandは後続の接続段で追加します'};}
  async function reconcile():Promise<void> {throw {code:'UNSUPPORTED_OPERATION',message:'復旧は後続の接続段で追加します'};}
}
