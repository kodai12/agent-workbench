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
  function validateTaskInput(
    repo: RepoRow,
    spec: ObjectValue,
    taskId?: string,
  ): void {
    unwrap(buildCheckPlan(spec, getPolicy(repo), []));
    for (const name of [
      text(spec.implementerProfile),
      ...strings(spec.reviewerProfiles),
    ])
      profile(name);
    for (const dep of strings(spec.dependsOn)) {
      const dependency = getTask(dep);
      mark(
        dependency.repo_id === repo.id,
        "DEPENDENCY_REPO_MISMATCH",
        "依存taskは同repoに限ります",
      );
      if (taskId) {
        const seen = new Set<string>(),
          stack = [dep];
        while (stack.length) {
          const current = stack.pop()!;
          mark(current !== taskId, "DEPENDENCY_CYCLE", "依存関係が循環します");
          if (seen.has(current)) continue;
          seen.add(current);
          for (const row of db
            .prepare(
              "SELECT dependency_id FROM task_dependencies WHERE task_id=?",
            )
            .all(current) as { dependency_id: string }[])
            stack.push(row.dependency_id);
        }
      }
    }
  }
  function replaceDependencies(taskId: string, spec: ObjectValue): void {
    db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(taskId);
    for (const dependency of strings(spec.dependsOn))
      db.prepare(
        "INSERT INTO task_dependencies(task_id,dependency_id) VALUES(?,?)",
      ).run(taskId, dependency);
  }
  async function dispatchBody(method:string,p:ObjectValue,actor:Actor,commandId:string):Promise<Json> {
const config = readConfig(home),
      boards = createBoardService(store, artifacts, config),
      handoffs = createHandoffService(store, artifacts, config);
if (method === "repo.list")
      return db
        .prepare("SELECT * FROM repositories ORDER BY name")
        .all() as Json;
if (method === "repo.get") {
      const repo = getRepo(text(p.repoId));
      const policy = db
        .prepare(
          "SELECT json,trusted_at_ms FROM config_versions WHERE digest=?",
        )
        .get(repo.policy_digest) as {
        json: string;
        trusted_at_ms: number | null;
      };
      return {
        ...repo,
        policy: decode(policy.json),
        policyTrusted: policy.trusted_at_ms !== null,
      };
    }
if (method === "repo.add") {
      const repoId = id("rep"),
        imported = unwrap(
          await git.importRepository(
            text(p.sourcePath),
            repoId,
            text(p.baseRef),
          ),
        );
      const disabled = configVersion("policy", {
        schemaVersion: 1,
        disabled: true,
      });
      db.prepare(
        "INSERT INTO repositories(id,name,source_path,managed_git_dir,source_base_ref,source_base_sha,integration_ref,integration_sha,object_format,policy_digest,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        repoId,
        text(p.name),
        imported.sourcePath,
        imported.managedPath,
        imported.baseRef,
        imported.baseSha,
        imported.integrationRef,
        imported.baseSha,
        imported.objectFormat,
        disabled,
        Date.now(),
      );
      return getRepo(repoId) as unknown as Json;
    }
if (method === "repo.syncPlan") {
      const repo = getRepo(text(p.repoId));
      return unwrap(await git.planSourceSync(repo.id)) as unknown as Json;
    }
if (method === "profiles.configure") {
      for (const [name, value] of Object.entries(object(p.profiles)))
        unwrap(validateContract("model-profile", value));
      const profiles = { ...config.profiles, ...object(p.profiles) };
      mark(
        config.devFixtures ||
          !Object.values(profiles).some((v) => object(v).driver === "fake"),
        "SIMULATED_EVIDENCE_FORBIDDEN",
        "fakeはfixture home専用です",
      );
      saveConfig(home, { ...config, profiles });
      return { profiles: Object.keys(profiles) };
    }
if (method === "policy.import") {
      const repo = getRepo(text(p.repoId)),
        policy = unwrap(validateContract("project-policy", p.policy));
      const d = configVersion("policy", policy);
      store.transact(() => {
        invalidateRepo(repo.id);
        db.prepare(
          "UPDATE repositories SET policy_digest=?,version=version+1 WHERE id=?",
        ).run(d, repo.id);
      });
      return { repoId: repo.id, policyDigest: d, trusted: false };
    }
if (method === "policy.trust") {
      const repo = getRepo(text(p.repoId));
      mark(
        text(p.expectDigest) === repo.policy_digest,
        "APPROVAL_STALE",
        "表示したpolicy digestと一致しません",
      );
      const row = db
        .prepare("SELECT json FROM config_versions WHERE digest=?")
        .get(repo.policy_digest) as { json: string };
      unwrap(validateContract("project-policy", decode(row.json)));
      db.prepare(
        "UPDATE config_versions SET trusted_at_ms=? WHERE digest=?",
      ).run(Date.now(), repo.policy_digest);
      return {
        repoId: repo.id,
        policyDigest: repo.policy_digest,
        trusted: true,
      };
    }
if (method === "system.doctor")
      return {
        node: process.version,
        simulated: config.devFixtures,
        strictSandboxVerified: false,
        liveVerified: false,
      };
if (method === "task.logs") {
      const task = getTask(text(p.taskId));
      const after = p.afterSeq === undefined ? 0 : number(p.afterSeq);
      mark(
        Number.isSafeInteger(after) && after >= 0,
        "INVALID_INPUT",
        "afterSeqが不正です",
      );
      return db
        .prepare(
          "SELECT * FROM events WHERE aggregate_id=? AND seq>? ORDER BY seq LIMIT 1000",
        )
        .all(task.id, after) as Json;
    }
if (method === "task.list")
      return db
        .prepare("SELECT * FROM tasks ORDER BY created_at_ms")
        .all() as Json;
if (method === "task.get") {
      const task = getTask(text(p.taskId));
      const candidate = task.active_candidate_id ? getCandidate(task) : null;
      return {
        ...task,
        candidate: candidate as unknown as Json,
        nextAction:
          task.state === "awaiting_approval"
            ? "approval.request"
            : task.state === "changes_required"
              ? "task.revise"
              : task.state === "recovery_required"
                ? "task.recover"
                : null,
      };
    }
if (method === "task.create") {
      const repo = getRepo(text(p.repoId)),
        spec = object(unwrap(validateContract("task-spec", p.spec)));
      validateTaskInput(repo, spec);
      const specArtifact = await saveArtifact(spec);
      const tid = id("tsk"),
        now = Date.now();
      store.transact(() => {
        db.prepare(
          "INSERT INTO tasks(id,repo_id,title,state,spec_json,spec_digest,policy_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          tid,
          repo.id,
          text(spec.title),
          "draft",
          canonical(spec),
          digest(spec),
          repo.policy_digest,
          now,
          now,
        );
        replaceDependencies(tid, spec);
        db.prepare("INSERT INTO artifact_links VALUES(?,?,?,?)").run(
          "task",
          tid,
          "spec:1",
          specArtifact.digest,
        );
        transition(
          tid,
          "TASK_SUBMITTED",
          { specValid: true, policyTrusted: true, profilesResolved: true },
          { specDigest: specArtifact.digest },
        );
      });
      return getTask(tid) as unknown as Json;
    }
throw {
      code: "UNSUPPORTED_OPERATION",
      message: "未対応のmethodです: " + method,
    };
}
  function invalidateRepo(repoId: string): void {
    for (const task of db
      .prepare("SELECT id,state FROM tasks WHERE repo_id=?")
      .all(repoId) as { id: string; state: string }[]) {
      invalidate(task.id);
      if (task.state === "awaiting_approval")
        transition(task.id, "CANDIDATE_INVALIDATED", {
          approvalRevoked: true,
          invalidationObserved: true,
        });
    }
  }
  async function dispatch(
    request: CommandRequest,
    actor: Actor,
  ): Promise<Json> {
    mark(
      request.schemaVersion === 1 &&
        /^req_[a-f0-9]{32}$/.test(request.requestId),
      "INVALID_INPUT",
      "RPC envelopeが不正です",
    );
    const allowed = knownParams[request.method];
    mark(!!allowed, "UNSUPPORTED_OPERATION", "未知のmethodです");
    requiredKeys(request.params, allowed!);
    if (privileged.includes(request.method))
      mark(actor.kind === "human", "PERMISSION_DENIED", "人間の接続が必要です");
    if (readMethods.has(request.method))
      return dispatchBody(request.method, request.params, actor, "");
    let aggregate =
      typeof request.params.taskId === "string"
        ? request.params.taskId
        : typeof request.params.repoId === "string"
          ? request.params.repoId
          : typeof request.params.boardId === "string"
            ? request.params.boardId
            : "global";
    if (["approval.grant", "approval.deny"].includes(request.method)) {
      const row = db
        .prepare("SELECT task_id FROM approval_requests WHERE id=?")
        .get(text(request.params.requestId)) as { task_id: string } | undefined;
      mark(!!row, "NOT_FOUND", "承認要求がありません");
      aggregate = row!.task_id;
    }
    if (request.method === "finding.disposition") {
      const row = db
        .prepare(
          "SELECT c.task_id FROM findings f JOIN reviews r ON r.id=f.review_id JOIN candidates c ON c.id=r.candidate_id WHERE f.id=?",
        )
        .get(text(request.params.findingId)) as { task_id: string } | undefined;
      mark(!!row, "NOT_FOUND", "findingがありません");
      aggregate = row!.task_id;
    }
    const binding = digest({
      method: request.method,
      params: request.params,
      actor: { kind: actor.kind, id: actor.id },
      aggregateId: aggregate,
      expectedVersion: request.expectedVersion,
    });
    const previous = db
      .prepare(
        "SELECT params_digest,result_json,error_json,state,id FROM commands WHERE request_id=?",
      )
      .get(request.requestId) as
      | {
          params_digest: string;
          result_json: string | null;
          error_json: string | null;
          state: string;
          id: string;
        }
      | undefined;
    if (previous) {
      mark(
        previous.params_digest === binding,
        "IDEMPOTENCY_CONFLICT",
        "同じrequestIdの内容が違います",
      );
      if (previous.error_json) throw decode(previous.error_json);
      return previous.result_json
        ? decode(previous.result_json)
        : { commandId: previous.id, state: previous.state };
    }
    const release = await acquireMutation();
    const commandId = id("cmd");
    try {
      const replay = db
        .prepare(
          "SELECT params_digest,result_json,error_json,state,id FROM commands WHERE request_id=?",
        )
        .get(request.requestId) as
        | {
            params_digest: string;
            result_json: string | null;
            error_json: string | null;
            state: string;
            id: string;
          }
        | undefined;
      if (replay) {
        mark(
          replay.params_digest === binding,
          "IDEMPOTENCY_CONFLICT",
          "同じrequestIdの内容が違います",
        );
        if (replay.error_json) throw decode(replay.error_json);
        return replay.result_json
          ? decode(replay.result_json)
          : { commandId: replay.id, state: replay.state };
      }
      mark(
        creates.has(request.method)
          ? request.expectedVersion === null
          : typeof request.expectedVersion === "number" &&
              Number.isSafeInteger(request.expectedVersion) &&
              request.expectedVersion > 0,
        "VERSION_CONFLICT",
        "mutationにはexpectedVersionが必要です",
      );
      if (request.expectedVersion !== null && aggregate !== "global") {
        const row = db
          .prepare(
            "SELECT version FROM tasks WHERE id=? UNION ALL SELECT version FROM repositories WHERE id=? UNION ALL SELECT version FROM boards WHERE id=?",
          )
          .get(aggregate, aggregate, aggregate) as
          | { version: number }
          | undefined;
        mark(
          !!row && row.version === request.expectedVersion,
          "VERSION_CONFLICT",
          "対象のversionが変わっています",
        );
      }
      db.prepare(
        "INSERT INTO commands(id,request_id,actor_kind,actor_id,method,params_json,params_digest,aggregate_id,expected_version,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        commandId,
        request.requestId,
        actor.kind,
        actor.id,
        request.method,
        canonical(request.params),
        binding,
        aggregate,
        request.expectedVersion,
        "executing",
        Date.now(),
        Date.now(),
      );
      const result = await dispatchBody(
        request.method,
        request.params,
        actor,
        commandId,
      );
      db.prepare(
        "UPDATE commands SET state='completed',result_json=?,updated_at_ms=? WHERE id=?",
      ).run(canonical(result), Date.now(), commandId);
      return result;
    } catch (error) {
      db.prepare(
        "UPDATE commands SET state='failed',error_json=?,updated_at_ms=? WHERE id=?",
      ).run(canonical(jsonError(error)), Date.now(), commandId);
      throw error;
    } finally {
      release();
    }
  }
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
  async function reconcile():Promise<void> {throw {code:'UNSUPPORTED_OPERATION',message:'復旧は後続の接続段で追加します'};}
}
