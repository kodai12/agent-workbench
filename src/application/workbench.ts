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
  async function contextFor(
    task: TaskRow,
    base: string,
  ): Promise<{
    instructionsDigest: Digest;
    contextDigest: Digest;
    instructions: Json;
    context: Json;
  }> {
    const repo = getRepo(task.repo_id),
      spec = record(task.spec_json);
    const names = (
      await gitRun([
        "--git-dir",
        repo.managed_git_dir,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        base,
      ])
    )
      .split("\0")
      .filter(Boolean);
    let total = 0;
    const capture = async (paths: string[]): Promise<Json> => {
      const files: Json[] = [];
      for (const path of paths) {
        mark(
          names.includes(path),
          "CONTEXT_MISSING",
          "baseにcontext fileがありません: " + path,
        );
        const bytes = Buffer.from(
          await gitRun(
            ["--git-dir", repo.managed_git_dir, "show", base + ":" + path],
            { encoding: "latin1" },
          ),
          "latin1",
        );
        total += bytes.length;
        mark(
          total <= 1048576,
          "RESOURCE_LIMIT",
          "contextと指示が1MiBを超えます",
        );
        const ref = unwrap(await artifacts.put(bytes, "text/plain", 1048576));
        files.push({ path, digest: ref.digest, sizeBytes: ref.sizeBytes });
      }
      return { base, files };
    };
    const instructions = await capture(
        names.filter(
          (name) => name === "AGENTS.md" || name.endsWith("/AGENTS.md"),
        ),
      ),
      context = await capture(strings(spec.contextFiles));
    const instructionsDigest = configVersion(
        "instructions",
        instructions,
        true,
      ),
      contextDigest = (await saveArtifact(context)).digest;
    return { instructionsDigest, contextDigest, instructions, context };
  }
  async function launchAttempt(
    task: TaskRow,
    row: WorkspaceRow,
    role: "implement" | "review",
    profileName: string,
    packet: Json,
  ): Promise<string> {
    const selected = profile(profileName),
      repo = getRepo(task.repo_id);
    mark(
      selected.driver === "fake" && knownFixture(repo),
      "SANDBOX_UNVERIFIED",
      "real providerのsandboxとegressは未検証です",
    );
    const aid = id("run"),
      instance = id("wrk"),
      dir = join(home, "workers", aid);
    privateDirectory(dir);
    const workerSocket = socketPathFor(dir);
    await prepareSocketDirectory(dir, workerSocket);
    const now = Date.now(),
      budget = object(record(task.spec_json).budget);
    const deadline = now + number(budget.wallTimeSeconds) * 1000;
    db.prepare(
      "INSERT INTO attempts(id,task_id,workspace_id,role,generation,driver,profile_json,state,writes_workspace,worker_instance_id,worker_socket,deadline_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      aid,
      task.id,
      row.id,
      role,
      task.generation,
      "fake",
      canonical({ ...selected, profileId: profileName }),
      "created",
      role === "implement" ? 1 : 0,
      instance,
      workerSocket,
      deadline,
    );
    if (role === "implement")
      db.prepare("INSERT INTO leases VALUES(?,?,?,?,?,?,?)").run(
        "writer:" + row.id,
        aid,
        instance,
        1,
        now,
        now + 30000,
        "held",
      );
    const sourceContext = await contextFor(task, row.base_sha);
    atomicWrite(
      join(dir, "packet.json"),
      canonical({
        ...object(packet),
        hostContext: sourceContext.context,
        hostInstructions: sourceContext.instructions,
      }),
    );
    atomicWrite(
      join(dir, "ticket.json"),
      canonical({
        attemptId: aid,
        workerInstanceId: instance,
        taskId: task.id,
        nonce: randomBytes(32).toString("hex"),
        workerSocket,
        cwd: row.path,
        driver: "fake",
        fixture: true,
        role,
        packetPath: join(dir, "packet.json"),
        maxLogBytes: 33554432,
        deadlineAtMs: deadline,
      }),
    );
    db.prepare(
      "UPDATE attempts SET state='starting',started_at_ms=? WHERE id=?",
    ).run(now, aid);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../worker/main.js", import.meta.url)),
        "--ticket",
        join(dir, "ticket.json"),
      ],
      { detached: true, stdio: "ignore", env: childEnvironment(dir), cwd: dir },
    );
    mark(
      child.pid !== undefined,
      "WORKER_START_FAILED",
      "workerを起動できませんでした",
    );
    processes.set(aid, child);
    db.prepare("UPDATE attempts SET process_identity_json=? WHERE id=?").run(
      canonical({
        pid: child.pid!,
        workerInstanceId: instance,
        startIdentity: processStartIdentity(child.pid!),
        startedAtMs: now,
      }),
      aid,
    );
    child.on("error", () => {});
    child.unref();
    return aid;
  }
  async function readSpool(attempt: AttemptRow): Promise<void> {
    const path = join(home, "workers", attempt.id, "events.jsonl");
    if (!existsSync(path)) return;
    const bytes = readFileSync(path);
    mark(bytes.length <= 33554432, "LOG_CAPACITY_EXCEEDED", "spool上限です");
    const last = bytes.lastIndexOf(10);
    for (const line of bytes
      .subarray(0, last + 1)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)) {
      const value = object(
        unwrap(validateContract("worker-event", unwrap(parseJson(line)))),
      );
      const workerEvent = {
        attemptId: text(value.attemptId),
        workerInstanceId: text(value.workerInstanceId),
        sourceSeq: number(value.sourceSeq),
        occurredAtMs: number(value.occurredAtMs),
        type: text(value.type),
        data: object(value.data),
      };
      unwrap(validateWorkerEventData(workerEvent.type, workerEvent.data));
      if (workerEvent.type === "worker.ready") {
        const identity = record(attempt.process_identity_json ?? "{}");
        mark(
          workerEvent.data.pid === identity.pid &&
            workerEvent.data.startIdentity === identity.startIdentity &&
            workerEvent.data.workerSocket === attempt.worker_socket,
          "WORKER_IDENTITY_MISMATCH",
          "worker.readyが予約identityと一致しません",
        );
      }
      unwrap(
        store.acceptWorkerEvent(workerEvent, (e) => {
          if (e.type === "worker.ready") {
            db.prepare("UPDATE attempts SET state='running' WHERE id=?").run(
              attempt.id,
            );
            if (
              attempt.role === "implement" &&
              getTask(attempt.task_id).state === "allocating"
            )
              transition(attempt.task_id, "WORKER_READY", {
                checkoutMatches: true,
                leaseMatches: true,
                workerMatches: true,
                sandboxVerified: false,
                fixtureMode: readConfig(home).devFixtures,
                knownFixture: knownFixture(
                  getRepo(getTask(attempt.task_id).repo_id),
                ),
                simulated: true,
              });
          }
        }),
      );
    }
  }
  async function freeze(taskId: string, attempt: AttemptRow): Promise<void> {
    const task = getTask(taskId),
      repo = getRepo(task.repo_id),
      spec = record(task.spec_json),
      policy = getPolicy(repo),
      scope = object(spec.scope),
      row = db
        .prepare("SELECT * FROM workspaces WHERE id=?")
        .get(attempt.workspace_id) as WorkspaceRow;
    const output = object(
      unwrap(
        validateContract(
          "implementation-output",
          decode(
            readFileSync(
              join(home, "workers", attempt.id, "output.json"),
              "utf8",
            ),
          ),
        ),
      ),
    );
    mark(
      output.declaredOutcome === "ready_for_verification",
      "OUTPUT_INVALID",
      "実装完了の出力がありません",
    );
    transition(taskId, "IMPLEMENTATION_RETURNED", {
      executionCompleted: true,
      outputValid: true,
      completionDeclared: true,
    });
    const snapshot = unwrap(
      await git
        .forRepository(repo.id)
        .freezeSnapshot(workRecord(row), row.base_sha, {
          writerStopped: true,
          scope: {
            allow: strings(scope.allowedPaths),
            deny: strings(scope.forbiddenPaths),
          },
          candidateRef: `refs/aw/candidates/${taskId}/${task.generation}`,
          specDigest: task.spec_digest,
          driver: "fake",
        }),
    );
    const plan = object(
      unwrap(
        buildCheckPlan(
          spec,
          policy,
          snapshot.manifest.files.map((file) => file.path),
        ),
      ),
    );
    const planDigest = configVersion("check_plan", plan, true),
      manifest = await saveArtifact(snapshot.manifest as unknown as Json),
      cid = id("cand");
    const sourceContext = await contextFor(task, row.base_sha);
    const identity = {
      schemaVersion: 1,
      repoId: repo.id,
      taskId,
      generation: task.generation,
      sourceBaseSha: repo.source_base_sha,
      integrationBaseSha: row.base_sha,
      candidateSha: snapshot.commit,
      candidateTreeSha: snapshot.tree,
      specDigest: task.spec_digest,
      policyDigest: task.policy_digest,
      checkPlanDigest: planDigest,
      instructionsDigest: sourceContext.instructionsDigest,
      contextDigest: sourceContext.contextDigest,
      environmentDigest: digest(environment(task)),
    };
    unwrap(validateContract("candidate-identity", identity));
    db.prepare(
      "INSERT INTO candidates(id,task_id,generation,identity_json,identity_digest,base_sha,candidate_sha,tree_sha,check_plan_digest,manifest_digest,state,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      cid,
      taskId,
      task.generation,
      canonical(identity),
      digest(identity),
      row.base_sha,
      snapshot.commit,
      snapshot.tree,
      planDigest,
      manifest.digest,
      "frozen",
      Date.now(),
    );
    db.prepare("UPDATE tasks SET active_candidate_id=? WHERE id=?").run(
      cid,
      taskId,
    );
    db.prepare("UPDATE workspaces SET state='frozen' WHERE id=?").run(row.id);
    transition(
      taskId,
      "CANDIDATE_FROZEN",
      {
        writerQuiescent: true,
        scopeValid: true,
        snapshotPersisted: true,
        manifestPersisted: true,
      },
      { candidateId: cid },
    );
    await verify(taskId, false);
    if (getTask(taskId).state === "reviewing") await review(taskId, false);
  }
  async function verify(taskId: string, rerun: boolean): Promise<Json> {
    const task = getTask(taskId),
      repo = getRepo(task.repo_id),
      candidate = getCandidate(task);
    mark(
      [
        "verifying",
        "reviewing",
        "awaiting_approval",
        "changes_required",
      ].includes(task.state),
      "INVALID_TRANSITION",
      "この状態ではcheckできません",
    );
    mark(
      knownFixture(repo),
      "SANDBOX_UNVERIFIED",
      "実check runnerにはsandbox検証が必要です",
    );
    if (rerun) {
      invalidate(taskId);
      db.prepare("UPDATE tasks SET state='verifying' WHERE id=?").run(taskId);
    }
    const stored = db
      .prepare("SELECT json FROM config_versions WHERE digest=?")
      .get(candidate.check_plan_digest) as { json: string };
    const plan = record(stored.json),
      checks = list(plan.checks).map(object);
    let allPassed = true;
    const { fixtureCheckRunner } = await import(
      "../adapters/fake/check-runner.js"
    );
    const runner = fixtureCheckRunner(home, artifacts);
    for (const check of checks) {
      const key = text(check.id);
      const previous = db
        .prepare(
          "SELECT state FROM checks WHERE candidate_id=? AND check_key=? ORDER BY execution_number DESC LIMIT 1",
        )
        .get(candidate.id, key) as { state: string } | undefined;
      if (previous && !rerun) {
        allPassed &&= previous.state === "passed";
        continue;
      }
      const numberRow = db
        .prepare(
          "SELECT coalesce(max(execution_number),0)+1 AS n FROM checks WHERE candidate_id=? AND check_key=?",
        )
        .get(candidate.id, key) as { n: number };
      const checkId = id("chk"),
        attemptId = id("run"),
        row = await workspace(task, "check", candidate.candidate_sha);
      const argv = strings(check.argv);
      argv[0] = executable(argv[0]!);
      db.prepare(
        "INSERT INTO checks(id,candidate_id,check_key,execution_number,state,required,command_digest,environment_digest,started_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        checkId,
        candidate.id,
        key,
        numberRow.n,
        "running",
        1,
        digest(check),
        digest(environment(task)),
        Date.now(),
      );
      const request = {
        attemptId,
        candidateIdentityDigest: candidate.identity_digest,
        checkId: key,
        cwd: row.path,
        argv,
        environment: {},
        timeoutMs: number(check.timeoutSeconds) * 1000,
        maxOutputBytes: number(check.maxOutputBytes),
        expectedArtifactPaths: strings(check.expectedArtifacts),
        network: "deny" as const,
        allowHosts: [],
      };
      const observed = await runner.execute(
        request,
        new AbortController().signal,
      );
      if (!observed.ok) {
        db.prepare(
          "UPDATE checks SET state='failed',ended_at_ms=? WHERE id=?",
        ).run(Date.now(), checkId);
        allPassed = false;
        await saveArtifact({ ...observed.error });
        continue;
      }
      const result = observed.value,
        passed =
          result.exitCode === 0 &&
          result.signal === null &&
          !result.timedOut &&
          result.sourceUnchanged &&
          request.expectedArtifactPaths.length === 0;
      const artifact = await saveArtifact(result as unknown as Json);
      db.prepare(
        "UPDATE checks SET state=?,exit_code=?,signal=?,timed_out=?,output_digest=?,result_digest=?,ended_at_ms=? WHERE id=?",
      ).run(
        passed ? "passed" : result.timedOut ? "timed_out" : "failed",
        result.exitCode,
        result.signal,
        result.timedOut ? 1 : 0,
        result.output.digest,
        artifact.digest,
        Date.now(),
        checkId,
      );
      allPassed &&= passed;
    }
    if (getTask(taskId).state === "verifying")
      transition(
        taskId,
        allPassed ? "CHECKS_PASSED" : "CHECKS_FAILED",
        allPassed
          ? {
              checksPassed: true,
              sameCandidate: true,
              outputsPresent: true,
              sourceUnchanged: true,
            }
          : { checkFailureObserved: true },
      );
    event(taskId, "CHECK_EVIDENCE_RECORDED", {
      candidateId: candidate.id,
      passed: allPassed,
    });
    return { candidateId: candidate.id, passed: allPassed };
  }
  async function finishWorker(attempt: AttemptRow): Promise<boolean> {
    await readSpool(attempt);
    const identity = attempt.process_identity_json
      ? record(attempt.process_identity_json)
      : null;
    mark(
      identity !== null,
      "PROCESS_IDENTITY_UNKNOWN",
      "worker identityがありません",
    );
    const child = processes.get(attempt.id),
      pid = number(identity!.pid);
    if (
      child
        ? child.exitCode === null && child.signalCode === null
        : processStartIdentity(pid) === text(identity!.startIdentity)
    ) {
      if (!child) {
        try {
          await controlWorker(home, attempt, "status");
        } catch (error) {
          if (processStartIdentity(pid) === text(identity!.startIdentity))
            throw error;
          return finishWorker(attempt);
        }
      }
      if (Date.now() > attempt.deadline_at_ms) {
        await controlWorker(home, attempt, "cancel");
        throw {
          code: "EXECUTION_UNCERTAIN",
          message: "deadlineを超えたworkerの停止確認が必要です",
        };
      }
      return false;
    }
    const rows = db
      .prepare(
        "SELECT type,payload_json FROM events WHERE attempt_id=? ORDER BY source_seq",
      )
      .all(attempt.id) as { type: string; payload_json: string }[];
    const completed = rows.find((e) => e.type === "run.completed");
    if (attempt.state === "stopping") {
      db.prepare(
        "UPDATE attempts SET state='cancelled',ended_at_ms=? WHERE id=?",
      ).run(Date.now(), attempt.id);
      db.prepare(
        "UPDATE leases SET status='released' WHERE owner_attempt_id=?",
      ).run(attempt.id);
      return true;
    }
    const success =
      !!completed &&
      !rows.some((e) => e.type === "run.failed" || e.type === "run.cancelled");
    mark(success, "EXECUTION_FAILED", "workerが正常完了していません");
    const completion = record(completed!.payload_json);
    const data = object(completion.data ?? completion);
    mark(
      data.finishReason === "completed" && data.processQuiescent === true,
      "EXECUTION_UNCERTAIN",
      "workerの完了証拠が不足しています",
    );
    mark(
      data.outputDigest ===
        bytesDigest(
          readFileSync(join(home, "workers", attempt.id, "output.json")),
        ),
      "ARTIFACT_CORRUPT",
      "worker出力digestが一致しません",
    );
    db.prepare(
      "UPDATE attempts SET state='completed',ended_at_ms=? WHERE id=?",
    ).run(Date.now(), attempt.id);
    db.prepare(
      "UPDATE leases SET status='released' WHERE owner_attempt_id=?",
    ).run(attempt.id);
    return true;
  }
  async function waitWorker(aid: string): Promise<AttemptRow> {
    for (;;) {
      const attempt = db
        .prepare("SELECT * FROM attempts WHERE id=?")
        .get(aid) as AttemptRow;
      mark(
        Date.now() < attempt.deadline_at_ms,
        "EXECUTION_UNCERTAIN",
        "worker deadlineを超えました",
      );
      if (await finishWorker(attempt)) return attempt;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function review(taskId: string, rerun: boolean): Promise<Json> {
    const task = getTask(taskId),
      repo = getRepo(task.repo_id),
      candidate = getCandidate(task),
      policy = getPolicy(repo),
      spec = record(task.spec_json);
    mark(
      ["reviewing", "awaiting_approval", "changes_required"].includes(
        task.state,
      ),
      "INVALID_TRANSITION",
      "レビュー可能な状態ではありません",
    );
    mark(
      knownFixture(repo),
      "SANDBOX_UNVERIFIED",
      "実reviewには独立sessionとsandbox検証が必要です",
    );
    if (rerun) {
      invalidate(taskId);
      db.prepare("UPDATE tasks SET state='reviewing' WHERE id=?").run(taskId);
    }
    const manifest = object(await artifactJson(candidate.manifest_digest)),
      changed = list(manifest.files).map((v) => text(object(v).path));
    const jobs: {
      aid: string;
      row: WorkspaceRow;
      profileName: string;
      execution: number;
      reviewId: string;
      contextDigest: Digest;
    }[] = [];
    for (const name of strings(spec.reviewerProfiles)) {
      const previous = db
        .prepare(
          "SELECT state FROM reviews WHERE candidate_id=? AND profile_id=? ORDER BY execution_number DESC LIMIT 1",
        )
        .get(candidate.id, name);
      if (previous && !rerun) continue;
      const selected = profile(name);
      mark(
        selected.driver === "fake",
        "EGRESS_DENIED",
        "外部reviewへの送信は許可されていません",
      );
      const row = await workspace(task, "review", candidate.candidate_sha);
      const checks = db
        .prepare(
          "SELECT check_key,state,result_digest FROM checks WHERE candidate_id=?",
        )
        .all(candidate.id) as Json[];
      const packet = makeReviewPacket({
        task: decode(task.spec_json),
        candidate: decode(candidate.identity_json),
        manifest,
        diffs: await gitRun([
          "--git-dir",
          repo.managed_git_dir,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          candidate.base_sha,
          candidate.candidate_sha,
        ]),
        constraints: { isolation: "fixture-only" },
        checks,
        coverage: { paths: changed },
        outputSchema: contracts.get("review-output.schema.json") as Json,
      });
      const packetValue = {
        ...object(packet),
        changedPaths: changed,
        requirements: spec.requirements ?? [],
      };
      const aid = await launchAttempt(task, row, "review", name, packetValue),
        reviewId = id("rev"),
        n = db
          .prepare(
            "SELECT coalesce(max(execution_number),0)+1 AS n FROM reviews WHERE candidate_id=? AND profile_id=?",
          )
          .get(candidate.id, name) as { n: number };
      const contextDigest = digest(packetValue);
      db.prepare(
        "INSERT INTO reviews(id,candidate_id,attempt_id,profile_id,execution_number,provider_id,training_family,model_id,context_digest,state,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        reviewId,
        candidate.id,
        aid,
        name,
        n.n,
        text(selected.providerId),
        text(selected.trainingFamily),
        typeof selected.modelId === "string" ? selected.modelId : "fake",
        contextDigest,
        "running",
        Date.now(),
      );
      jobs.push({
        aid,
        row,
        profileName: name,
        execution: n.n,
        reviewId,
        contextDigest,
      });
    }
    const sources: Record<string, SourceEvidence> = {};
    for (const file of list(manifest.files).map(object)) {
      if (file.change === "deleted") continue;
      const content = await gitRun([
        "--git-dir",
        repo.managed_git_dir,
        "show",
        candidate.candidate_sha + ":" + text(file.path),
      ]);
      sources[text(file.path)] = {
        digest: toDigest(text(file.contentSha256)),
        lineCount: content.split("\n").length,
        candidateIdentityDigest: candidate.identity_digest,
        kind: "file",
      };
    }
    for (const job of jobs) {
      await waitWorker(job.aid);
      const raw = readFileSync(
        join(home, "workers", job.aid, "output.json"),
        "utf8",
      );
      const output = unwrap(parseJson(raw));
      const checked = validateReview(output, {
        candidateIdentityDigest: candidate.identity_digest,
        changedPaths: changed,
        requirementIds: list(spec.requirements).map((v) => text(object(v).id)),
        sources,
        fresh: true,
        readOnly:
          (await gitRun([
            "-C",
            job.row.path,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ])) === "" &&
          (await gitRun(["-C", job.row.path, "rev-parse", "HEAD"])).trim() ===
            candidate.candidate_sha,
        authorAttemptId: text(
          (
            db
              .prepare(
                "SELECT id FROM attempts WHERE task_id=? AND role='implement' ORDER BY started_at_ms DESC LIMIT 1",
              )
              .get(taskId) as { id: string }
          ).id,
        ),
        reviewAttemptId: job.aid,
      });
      const saved = await saveArtifact(raw);
      db.prepare(
        "UPDATE reviews SET state=?,output_digest=?,verdict=? WHERE id=?",
      ).run(
        checked.ok ? "valid" : "invalid",
        saved.digest,
        checked.ok ? text(object(checked.value).verdict) : null,
        job.reviewId,
      );
      if (checked.ok)
        for (const finding of list(object(checked.value).findings).map(object))
          db.prepare(
            "INSERT INTO findings(id,review_id,local_key,severity,fingerprint,payload_json) VALUES(?,?,?,?,?,?)",
          ).run(
            id("fnd"),
            job.reviewId,
            text(finding.key),
            text(finding.severity),
            digest(finding),
            canonical(finding),
          );
    }
    const gate = await gateFor(taskId);
    if (getTask(taskId).state === "reviewing")
      transition(
        taskId,
        gate.passed ? "REVIEWS_PASSED" : "REVIEWS_FAILED",
        gate.passed
          ? {
              reviewGatePassed: true,
              familiesSufficient: true,
              coverageComplete: true,
              findingsDisposed: true,
            }
          : { reviewFailureObserved: true },
      );
    event(taskId, "REVIEW_EVIDENCE_RECORDED", {
      candidateId: candidate.id,
      passed: gate.passed,
    });
    return gate as unknown as Json;
  }
  async function gateFor(taskId: string) {
    const task = getTask(taskId),
      repo = getRepo(task.repo_id),
      candidate = getCandidate(task),
      policy = getPolicy(repo),
      spec = record(task.spec_json),
      identity = record(candidate.identity_json),
      plan = record(
        (
          db
            .prepare("SELECT json FROM config_versions WHERE digest=?")
            .get(candidate.check_plan_digest) as { json: string }
        ).json,
      ),
      manifest = object(await artifactJson(candidate.manifest_digest));
    const checks: CheckResult[] = [];
    for (const row of db
      .prepare(
        "SELECT result_digest FROM checks c WHERE candidate_id=? AND execution_number=(SELECT max(execution_number) FROM checks WHERE candidate_id=c.candidate_id AND check_key=c.check_key)",
      )
      .all(candidate.id) as { result_digest: Digest | null }[]) {
      if (row.result_digest)
        checks.push(
          (await artifactJson(row.result_digest)) as unknown as CheckResult,
        );
    }
    const reviews: GateReview[] = [];
    for (const row of db
      .prepare("SELECT * FROM reviews WHERE candidate_id=?")
      .all(candidate.id) as {
      id: string;
      profile_id: string;
      training_family: string;
      output_digest: Digest | null;
      state: string;
      execution_number: number;
    }[]) {
      if (!row.output_digest) continue;
      reviews.push({
        id: row.id,
        profileId: row.profile_id,
        trainingFamily: row.training_family,
        candidateIdentityDigest: candidate.identity_digest,
        artifactDigest: row.output_digest,
        output: await artifactJson(row.output_digest),
        valid: row.state === "valid",
        fresh: true,
        readOnly: true,
        simulated: knownFixture(repo),
        execution: row.execution_number,
      });
    }
    const digests = new Set<string>();
    for (const row of db.prepare("SELECT digest FROM artifacts").all() as {
      digest: Digest;
    }[]) {
      const checked = await artifacts.readVerified(row.digest);
      if (checked.ok) digests.add(row.digest);
    }
    const writer =
      number(
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM attempts WHERE task_id=? AND writes_workspace=1 AND state IN ('created','starting','running','waiting_input','stopping','unknown')",
            )
            .get(taskId) as { n: number }
        ).n,
      ) > 0;
    let minFamilies = number(plan.minimumTrainingFamilies),
      minReviews = number(plan.minimumReviewers);
    if (spec.risk === "high") {
      minFamilies = Math.max(2, minFamilies);
      minReviews = Math.max(2, minReviews);
    }
    const changed = list(manifest.files).map((v) => text(object(v).path));
    const dispositions: FindingDisposition[] = [];
    for (const row of db
      .prepare(
        "SELECT d.*,f.review_id,f.local_key FROM finding_dispositions d JOIN findings f ON f.id=d.finding_id JOIN reviews r ON r.id=f.review_id WHERE r.candidate_id=?",
      )
      .all(candidate.id) as {
      review_id: string;
      local_key: string;
      disposition_version: number;
      disposition: FindingDisposition["state"];
      actor_kind: string;
      actor_id: string;
      reason: string;
      evidence_digest: Digest | null;
    }[]) {
      dispositions.push({
        findingId: row.review_id + ":" + row.local_key,
        version: row.disposition_version,
        state: row.disposition,
        actor: { kind: "human", id: row.actor_id, connectionId: "local" },
        independentReviewer: row.actor_kind === "independent_reviewer",
        reason: row.reason,
        evidence: row.evidence_digest ? [row.evidence_digest] : [],
      });
    }
    const input: GateInput = {
      candidateIdentity: identity,
      candidateIdentityDigest: candidate.identity_digest,
      currentIdentity: {
        ...identity,
        specDigest: task.spec_digest,
        policyDigest: repo.policy_digest,
        environmentDigest: digest(environment(task)),
      },
      requiredCheckIds: list(plan.checks).map((v) => text(object(v).id)),
      checks,
      reviews,
      requiredReviewerProfiles: strings(spec.reviewerProfiles),
      minimumReviewers: minReviews,
      minimumTrainingFamilies: minFamilies,
      blockSeverities: strings(plan.blockSeverities),
      changedPaths: changed,
      requirementIds: list(spec.requirements).map((v) => text(object(v).id)),
      dispositions,
      authorId: taskId,
      risk: text(plan.risk),
      allowedRiskSeverities: ["medium", "low"],
      artifacts: digests,
      activeWriter: writer,
      pendingPermission: false,
      budgetValid:
        Date.now() - task.created_at_ms <=
        number(object(spec.budget).wallTimeSeconds) * 1000,
      protocolValid: knownFixture(repo),
      fixtureMode: knownFixture(repo),
    };
    return evaluateGate(input);
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
if (method === "task.start") {
      const task = getTask(text(p.taskId)),
        repo = getRepo(task.repo_id),
        policy = getPolicy(repo),
        spec = record(task.spec_json),
        selected = profile(text(spec.implementerProfile));
      mark(
        task.state === "ready",
        "INVALID_TRANSITION",
        "ready状態のtaskだけ開始できます",
      );
      mark(
        task.policy_digest === repo.policy_digest,
        "POLICY_CHANGED",
        "policy変更後は新generationが必要です",
      );
      mark(
        selected.driver === "fake" && knownFixture(repo),
        "SANDBOX_UNVERIFIED",
        "現在の実binaryでは厳格sandboxのcanaryが未検証です",
      );
      mark(
        (p.interaction ?? spec.interaction) === "managed" &&
          (p.presentation ?? policy.presentation) === "none",
        "PRESENTATION_VARIANT_UNSUPPORTED",
        "fake fixtureはmanaged/noneだけ対応します",
      );
      const active = db
        .prepare(
          "SELECT count(*) AS n FROM attempts WHERE writes_workspace=1 AND state IN ('created','starting','running','waiting_input','stopping','unknown')",
        )
        .get() as { n: number };
      mark(
        active.n < number(object(policy.limits).maxActiveWriters),
        "WORKSPACE_BUSY",
        "writer上限です",
      );
      const attempts = db
        .prepare(
          "SELECT count(*) AS n FROM attempts WHERE task_id=? AND role='implement'",
        )
        .get(task.id) as { n: number };
      mark(
        attempts.n < number(object(spec.budget).maxAttempts),
        "BUDGET_EXCEEDED",
        "attempt予算を超えました",
      );
      const deps = db
        .prepare(
          "SELECT d.dependency_id,t.state,c.candidate_sha FROM task_dependencies d JOIN tasks t ON t.id=d.dependency_id LEFT JOIN candidates c ON c.id=t.active_candidate_id WHERE d.task_id=?",
        )
        .all(task.id) as {
        dependency_id: string;
        state: string;
        candidate_sha: string | null;
      }[];
      for (const dep of deps) {
        mark(
          dep.state === "integrated" && !!dep.candidate_sha,
          "DEPENDENCY_UNRESOLVED",
          "依存taskが未統合です",
        );
        db.prepare(
          "UPDATE task_dependencies SET required_candidate_sha=? WHERE task_id=? AND dependency_id=?",
        ).run(dep.candidate_sha, task.id, dep.dependency_id);
      }
      transition(task.id, "START_REQUESTED", {
        dependenciesComplete: true,
        dependencyShasFixed: true,
        noActiveRun: true,
        budgetAvailable: true,
      });
      const row = await workspace(task, "writer", repo.integration_sha);
      const aid = await launchAttempt(
        task,
        row,
        "implement",
        text(spec.implementerProfile),
        {
          objective: spec.objective ?? "",
          requirements: spec.requirements ?? [],
          scope: spec.scope ?? {},
        },
      );
      return {
        taskId: task.id,
        attemptId: aid,
        workspaceId: row.id,
        state: "allocating",
      };
    }
if (method === "task.cancel") {
      const task = getTask(text(p.taskId));
      const active = db
        .prepare(
          "SELECT * FROM attempts WHERE task_id=? AND writes_workspace=1 AND state IN ('created','starting','running','waiting_input','stopping','unknown')",
        )
        .all(task.id) as AttemptRow[];
      if (active.length) {
        for (const attempt of active) {
          db.prepare("UPDATE attempts SET state='stopping' WHERE id=?").run(
            attempt.id,
          );
          try {
            await controlWorker(home, attempt, "cancel");
          } catch (error) {
            if (
              processStartIdentity(
                number(record(attempt.process_identity_json ?? "{}").pid),
              ) !== null
            )
              throw error;
          }
        }
        event(task.id, "CANCEL_REQUESTED", { reason: p.reason ?? null });
        return { taskId: task.id, state: task.state, cancelRequested: true };
      }
      transition(task.id, "CANCEL_QUIESCENT", {
        noActiveWriter: true,
        historyPreserved: true,
      });
      invalidate(task.id);
      return getTask(task.id) as unknown as Json;
    }
if (method === "task.revise") {
      const task = getTask(text(p.taskId));
      mark(
        task.state === "changes_required",
        "INVALID_TRANSITION",
        "changes_requiredだけ改訂できます",
      );
      const spec = p.spec
        ? unwrap(validateContract("task-spec", p.spec))
        : decode(task.spec_json);
      validateTaskInput(getRepo(task.repo_id), object(spec), task.id);
      const specArtifact = await saveArtifact(spec);
      store.transact(() => {
        invalidate(task.id);
        replaceDependencies(task.id, object(spec));
        db.prepare("INSERT INTO artifact_links VALUES(?,?,?,?)").run(
          "task",
          task.id,
          "spec:" + String(task.generation + 1),
          specArtifact.digest,
        );
        db.prepare(
          "UPDATE tasks SET generation=generation+1,active_candidate_id=NULL,spec_json=?,spec_digest=?,policy_digest=? WHERE id=?",
        ).run(
          canonical(spec),
          digest(spec),
          getRepo(task.repo_id).policy_digest,
          task.id,
        );
        transition(
          task.id,
          "REVISION_REQUESTED",
          { revisionAuthorized: true, generationIncreased: true },
          {
            previousSpecDigest: task.spec_digest,
            specDigest: specArtifact.digest,
          },
        );
      });
      return getTask(task.id) as unknown as Json;
    }
if (method === "task.recover") {
      const task = getTask(text(p.taskId)),
        attempts = db
          .prepare(
            "SELECT * FROM attempts WHERE task_id=? AND state IN ('unknown','stopping','running','starting')",
          )
          .all(task.id) as AttemptRow[];
      const plan = {
        taskId: task.id,
        version: task.version,
        attempts: attempts.map((a) => ({
          id: a.id,
          identity: a.process_identity_json
            ? decode(a.process_identity_json)
            : null,
          alive: a.process_identity_json
            ? alive(number(record(a.process_identity_json).pid))
            : null,
        })),
      };
      const hash = digest(plan);
      if (!p.planDigest) return { plan, planDigest: hash };
      mark(
        p.planDigest === hash,
        "VERSION_CONFLICT",
        "復旧計画が変化しています",
      );
      mark(
        plan.attempts.every((a) => a.alive === false),
        "WRITER_NOT_QUIESCENT",
        "旧worker停止を確定できません",
      );
      store.transact(() => {
        db.prepare(
          "UPDATE attempts SET state='failed',ended_at_ms=? WHERE task_id=? AND state IN ('unknown','stopping','running','starting')",
        ).run(Date.now(), task.id);
        db.prepare(
          "UPDATE leases SET status='released' WHERE owner_attempt_id IN (SELECT id FROM attempts WHERE task_id=?)",
        ).run(task.id);
        db.prepare(
          "UPDATE tasks SET generation=generation+1,active_candidate_id=NULL WHERE id=?",
        ).run(task.id);
        transition(task.id, "RECOVERY_RETRY_AUTHORIZED", {
          oldWriterQuiescent: true,
          workspacePreserved: true,
          generationIncreased: true,
        });
      });
      return getTask(task.id) as unknown as Json;
    }
if (method === "approval.request") {
      const task = getTask(text(p.taskId)),
        repo = getRepo(task.repo_id),
        candidate = getCandidate(task),
        policy = getPolicy(repo);
      mark(
        task.state === "awaiting_approval",
        "INVALID_TRANSITION",
        "承認待ち状態ではありません",
      );
      mark(
        p.action === "integrate",
        "UNSUPPORTED_OPERATION",
        "初版はintegrate承認のみ対応します",
      );
      const gate = await gateFor(task.id);
      mark(gate.passed, "GATE_BLOCKED", "必要な証拠が揃っていません");
      const binding: ApprovalBinding = {
        schemaVersion: 1,
        action: "integrate",
        repoId: repo.id,
        taskId: task.id,
        candidateIdentityDigest: candidate.identity_digest,
        evidenceDigest: gate.evidenceDigest,
        targetRef: repo.integration_ref,
        expectedBaseSha: repo.integration_sha,
        expiresAtMs:
          Date.now() +
          number(object(policy.integration).approvalTtlSeconds) * 1000,
        nonce: randomBytes(32).toString("hex"),
      };
      unwrap(validateContract("approval-binding", binding));
      const requestId = id("apr"),
        hash = digest(binding);
      db.prepare(
        "INSERT INTO approval_requests(id,task_id,candidate_id,action,binding_json,binding_digest,evidence_digest,nonce,expires_at_ms,state,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        requestId,
        task.id,
        candidate.id,
        "integrate",
        canonical(binding),
        hash,
        gate.evidenceDigest,
        binding.nonce,
        binding.expiresAtMs,
        "pending",
        Date.now(),
      );
      return {
        requestId,
        bindingDigest: hash,
        binding: { ...binding },
        simulated: knownFixture(repo),
        gate: gate as unknown as Json,
      };
    }
if (method.startsWith("approval.")) {
      mark(
        (typeof p.requestId === "string") !==
          (typeof p.approvalId === "string"),
        "INVALID_INPUT",
        "requestIdかapprovalIdを一つ指定してください",
      );
      const row = (
        typeof p.approvalId === "string"
          ? db
              .prepare(
                "SELECT r.*,a.id AS approvalId FROM approval_requests r JOIN approvals a ON a.request_id=r.id WHERE a.id=?",
              )
              .get(p.approvalId)
          : db
              .prepare("SELECT * FROM approval_requests WHERE id=?")
              .get(text(p.requestId))
      ) as
        | {
            id: string;
            task_id: string;
            binding_json: string;
            binding_digest: Digest;
            state: string;
            expires_at_ms: number;
          }
        | undefined;
      mark(!!row, "NOT_FOUND", "承認要求がありません");
      const request = row!;
      if (method === "approval.get")
        return { ...request, binding: decode(request.binding_json) };
      mark(
        text(p.expectDigest) === request.binding_digest,
        "APPROVAL_STALE",
        "承認digestが一致しません",
      );
      mark(
        request.state === "pending",
        "APPROVAL_STALE",
        "承認は未決ではありません",
      );
      mark(
        Date.now() < request.expires_at_ms,
        "APPROVAL_EXPIRED",
        "承認期限が切れました",
      );
      const binding = decode(
        request.binding_json,
      ) as unknown as ApprovalBinding;
      const gate = await gateFor(request.task_id);
      unwrap(
        validateApproval(binding, {
          actor,
          bindingDigest: request.binding_digest,
          expected: binding,
          nowMs: Date.now(),
          usedNonces: new Set(),
          revoked: false,
          gate,
        }),
      );
      if (method === "approval.deny") {
        store.transact(() => {
          db.prepare(
            "UPDATE approval_requests SET state='denied' WHERE id=?",
          ).run(request.id);
          event(
            request.task_id,
            "APPROVAL_REVOKED",
            { requestId: request.id },
            actor,
          );
        });
        return { requestId: request.id, state: "denied" };
      }
      const approvalId = id("apv");
      store.transact(() => {
        db.prepare(
          "INSERT INTO approvals(id,request_id,human_actor_id,binding_digest,granted_at_ms) VALUES(?,?,?,?,?)",
        ).run(
          approvalId,
          request.id,
          actor.id,
          request.binding_digest,
          Date.now(),
        );
        db.prepare(
          "UPDATE approval_requests SET state='granted' WHERE id=?",
        ).run(request.id);
        event(
          request.task_id,
          "APPROVAL_GRANTED",
          { approvalId, requestId: request.id },
          actor,
        );
      });
      return { approvalId, requestId: request.id, state: "granted" };
    }
if (method === "task.integrate")
      return integrate(text(p.taskId), text(p.approvalId), actor, commandId);
if (method === "task.export") {
      const task = getTask(text(p.taskId)),
        candidate = getCandidate(task);
      mark(
        p.format === "git-bundle",
        "UNSUPPORTED_OPERATION",
        "git-bundleだけ対応します",
      );
      return unwrap(
        await git
          .forRepository(task.repo_id)
          .exportBundle(
            `refs/aw/candidates/${task.id}/${task.generation}`,
            candidate.base_sha,
            resolve(text(p.out)),
            candidate.candidate_sha,
          ),
      ) as unknown as Json;
    }
if (method === "findings.list")
      return db
        .prepare(
          "SELECT * FROM findings WHERE review_id IN (SELECT id FROM reviews WHERE candidate_id=?)",
        )
        .all(text(p.candidateId)) as Json;
if (method === "findings.get") {
      const value = db
        .prepare("SELECT * FROM findings WHERE id=?")
        .get(text(p.findingId));
      mark(!!value, "NOT_FOUND", "findingがありません");
      return value as Json;
    }
if (method === "finding.disposition") {
      const finding = db
        .prepare(
          "SELECT f.*,r.candidate_id,c.task_id FROM findings f JOIN reviews r ON r.id=f.review_id JOIN candidates c ON c.id=r.candidate_id WHERE f.id=?",
        )
        .get(text(p.findingId)) as
        | { id: string; severity: string; task_id: string }
        | undefined;
      mark(!!finding, "NOT_FOUND", "findingがありません");
      const prior = db
        .prepare(
          "SELECT coalesce(max(disposition_version),0)+1 AS n FROM finding_dispositions WHERE finding_id=?",
        )
        .get(finding!.id) as { n: number };
      const state = text(p.disposition);
      mark(
        ["open", "confirmed", "false_positive", "risk_accepted"].includes(
          state,
        ),
        "INVALID_INPUT",
        "処置が不正です",
      );
      const evidence = p.evidenceDigest
        ? toDigest(text(p.evidenceDigest))
        : null;
      if (evidence) unwrap(await artifacts.readVerified(evidence));
      const input: FindingDisposition = {
        findingId: finding!.id,
        version: prior.n,
        state: state as FindingDisposition["state"],
        actor,
        independentReviewer: false,
        reason: text(p.reason),
        evidence: evidence ? [evidence] : [],
      };
      unwrap(
        validateDisposition(input, finding!.task_id, finding!.severity, [
          "medium",
          "low",
        ]),
      );
      invalidate(finding!.task_id);
      db.prepare(
        "INSERT INTO finding_dispositions(id,finding_id,disposition_version,disposition,reason,actor_kind,actor_id,evidence_digest,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id("dsp"),
        finding!.id,
        prior.n,
        state,
        p.reason,
        actor.kind,
        actor.id,
        evidence,
        Date.now(),
      );
      event(
        finding!.task_id,
        "FINDING_DISPOSITION_RECORDED",
        { findingId: finding!.id, state },
        actor,
      );
      return { findingId: finding!.id, state };
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
  async function integrate(
    taskId: string,
    approvalId: string,
    actor: Actor,
    commandId: string,
  ): Promise<Json> {
    const task = getTask(taskId),
      repo = getRepo(task.repo_id),
      candidate = getCandidate(task),
      gate = await gateFor(taskId);
    const approval = db
      .prepare(
        "SELECT a.*,r.binding_json,r.state AS request_state FROM approvals a JOIN approval_requests r ON r.id=a.request_id WHERE a.id=?",
      )
      .get(approvalId) as
      | {
          id: string;
          request_id: string;
          binding_digest: Digest;
          binding_json: string;
          revoked_at_ms: number | null;
          consumed_by_command_id: string | null;
          request_state: string;
        }
      | undefined;
    mark(!!approval, "APPROVAL_REQUIRED", "承認が必要です");
    const approved = approval!,
      binding = decode(approved.binding_json) as unknown as ApprovalBinding;
    const expected: ApprovalBinding = {
      ...binding,
      repoId: repo.id,
      taskId,
      candidateIdentityDigest: candidate.identity_digest,
      evidenceDigest: gate.evidenceDigest,
      targetRef: repo.integration_ref,
      expectedBaseSha: repo.integration_sha,
    };
    unwrap(
      validateApproval(binding, {
        actor,
        bindingDigest: approved.binding_digest,
        expected,
        nowMs: Date.now(),
        usedNonces: new Set(
          approved.consumed_by_command_id ? [binding.nonce] : [],
        ),
        revoked:
          approved.revoked_at_ms !== null ||
          approved.request_state !== "granted",
        gate,
      }),
    );
    mark(
      binding.expectedBaseSha ===
        unwrap(await git.forRepository(repo.id).readRef(repo.integration_ref)),
      "BASE_MOVED",
      "管理refが移動しています",
    );
    const integrationId = id("int");
    store.transact(() => {
      db.prepare(
        "INSERT INTO integrations(id,task_id,candidate_id,approval_id,command_id,target_ref,expected_old_sha,new_sha,state,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        integrationId,
        taskId,
        candidate.id,
        approved.id,
        commandId,
        repo.integration_ref,
        binding.expectedBaseSha,
        candidate.candidate_sha,
        "prepared",
        Date.now(),
      );
      db.prepare(
        "UPDATE approvals SET consumed_by_command_id=? WHERE id=? AND consumed_by_command_id IS NULL",
      ).run(commandId, approved.id);
      transition(taskId, "INTEGRATION_AUTHORIZED", {
        approvalValid: true,
        bindingMatches: true,
        baseMatches: true,
        noActiveWriter: true,
      });
    });
    const changed = await git
      .forRepository(repo.id)
      .compareAndSwapRef(
        repo.integration_ref,
        binding.expectedBaseSha,
        candidate.candidate_sha,
      );
    if (!changed.ok) {
      invalidate(taskId);
      transition(taskId, "BASE_MOVED", { casFailed: true });
      throw changed.error;
    }
    confirmIntegration(
      integrationId,
      taskId,
      repo.id,
      candidate.id,
      approved.request_id,
      candidate.candidate_sha,
    );
    return {
      integrationId,
      taskId,
      state: "integrated",
      targetRef: repo.integration_ref,
      candidateSha: candidate.candidate_sha,
    };
  }
  function confirmIntegration(
    integrationId: string,
    taskId: string,
    repoId: string,
    candidateId: string,
    requestId: string,
    sha: string,
  ): void {
    store.transact(() => {
      db.prepare(
        "UPDATE integrations SET state='applied',confirmed_at_ms=? WHERE id=?",
      ).run(Date.now(), integrationId);
      db.prepare(
        "UPDATE approval_requests SET state='consumed' WHERE id=?",
      ).run(requestId);
      db.prepare(
        "UPDATE repositories SET integration_sha=?,version=version+1 WHERE id=?",
      ).run(sha, repoId);
      db.prepare("UPDATE candidates SET state='integrated' WHERE id=?").run(
        candidateId,
      );
      transition(taskId, "INTEGRATION_CONFIRMED", {
        refMatchesCandidate: true,
        journalConfirmed: true,
      });
    });
  }
  async function reconcile(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    const release = await acquireMutation();
    try {
      for (const attempt of db
        .prepare(
          "SELECT * FROM attempts WHERE role='implement' AND state IN ('starting','running','stopping')",
        )
        .all() as AttemptRow[]) {
        try {
          if (await finishWorker(attempt)) {
            const task = getTask(attempt.task_id);
            if (attempt.state === "stopping") {
              transition(task.id, "CANCEL_QUIESCENT", {
                noActiveWriter: true,
                historyPreserved: true,
              });
              continue;
            }
            await freeze(attempt.task_id, attempt);
          }
        } catch (error) {
          db.prepare(
            "UPDATE attempts SET state='unknown',error_json=? WHERE id=?",
          ).run(canonical(jsonError(error)), attempt.id);
          const task = getTask(attempt.task_id);
          if (
            !["integrated", "cancelled", "recovery_required"].includes(
              task.state,
            )
          )
            transition(
              task.id,
              "EXECUTION_UNCERTAIN",
              { uncertaintyObserved: true },
              { error: jsonError(error) },
            );
        }
      }
      for (const integration of db
        .prepare(
          "SELECT i.*,r.repo_id FROM integrations i JOIN tasks r ON r.id=i.task_id WHERE i.state='prepared'",
        )
        .all() as {
        id: string;
        task_id: string;
        repo_id: string;
        candidate_id: string;
        approval_id: string;
        command_id: string;
        target_ref: string;
        expected_old_sha: string;
        new_sha: string;
      }[]) {
        const result = unwrap(
          await git
            .forRepository(integration.repo_id)
            .reconcileIntegration(
              integration.target_ref,
              integration.expected_old_sha,
              integration.new_sha,
            ),
        );
        if (result === "applied") {
          const approval = db
            .prepare("SELECT request_id FROM approvals WHERE id=?")
            .get(integration.approval_id) as { request_id: string };
          confirmIntegration(
            integration.id,
            integration.task_id,
            integration.repo_id,
            integration.candidate_id,
            approval.request_id,
            integration.new_sha,
          );
          db.prepare(
            "UPDATE commands SET state='completed',result_json=?,updated_at_ms=? WHERE id=?",
          ).run(
            canonical({ taskId: integration.task_id, state: "integrated" }),
            Date.now(),
            integration.command_id,
          );
        } else if (result === "uncertain") {
          db.prepare(
            "UPDATE integrations SET state='uncertain' WHERE id=?",
          ).run(integration.id);
          const task = getTask(integration.task_id);
          if (task.state === "integrating")
            transition(task.id, "EXECUTION_UNCERTAIN", {
              uncertaintyObserved: true,
            });
        }
      }
    } finally {
      release();
      reconciling = false;
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
  for (const task of db
    .prepare(
      "SELECT * FROM tasks WHERE state IN ('allocating','running','waiting_human','freezing','verifying','reviewing','integrating')",
    )
    .all() as TaskRow[]) {
    const prepared = db
      .prepare(
        "SELECT 1 FROM integrations WHERE task_id=? AND state='prepared'",
      )
      .get(task.id);
    if (prepared) continue;
    const active = db
      .prepare(
        "SELECT * FROM attempts WHERE task_id=? AND writes_workspace=1 AND state IN ('created','starting','running','waiting_input','stopping','unknown')",
      )
      .all(task.id) as AttemptRow[];
    if (
      active.length &&
      active.every(
        (attempt) =>
          attempt.process_identity_json !== null && attempt.state !== "created",
      )
    )
      continue;
    store.transact(() => {
      db.prepare(
        "UPDATE attempts SET state='unknown' WHERE task_id=? AND state IN ('created','starting','running','waiting_input','stopping')",
      ).run(task.id);
      db.prepare(
        "UPDATE checks SET state='unknown' WHERE candidate_id IN (SELECT id FROM candidates WHERE task_id=?) AND state='running'",
      ).run(task.id);
      transition(
        task.id,
        "EXECUTION_UNCERTAIN",
        { uncertaintyObserved: true },
        { reason: "daemonの継続処理が失われたため明示復旧が必要です" },
      );
    });
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
}
