import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, Actor } from "../../contracts/ports.js";
import { initialize } from "../../src/application/config.js";
import { createWorkbench } from "../../src/application/workbench.js";
import { object, text, number } from "../../src/application/data.js";
import { id } from "../../src/adapters/os/paths.js";
const actor: Actor = { kind: "human", id: "test-human", connectionId: "first" };
const policy = JSON.parse(
  readFileSync(
    new URL("../../../examples/project-policy.json", import.meta.url),
    "utf8",
  ),
) as Json;
const spec = object(
  JSON.parse(
    readFileSync(
      new URL("../../../examples/task-spec.json", import.meta.url),
      "utf8",
    ),
  ),
);
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "aw-recovery-")));
  const source = initialize(home, true).fixture!;
  const app = createWorkbench(home);
  const call = async (
    method: string,
    params: { [key: string]: Json },
    expectedVersion: number | null = null,
  ) =>
    object(
      await app.dispatch(
        {
          schemaVersion: 1,
          requestId: id("req"),
          method,
          params,
          expectedVersion,
        },
        actor,
      ),
    );
  const repo = await call("repo.add", {
      sourcePath: source,
      name: "demo",
      baseRef: "refs/heads/main",
    }),
    repoId = text(repo.id);
  const imported = await call("policy.import", { repoId, policy });
  const current = await call("repo.get", { repoId });
  await call(
    "policy.trust",
    { repoId, expectDigest: imported.policyDigest! },
    number(current.version),
  );
  return { home, app, call, repoId };
}

test("改訂した依存とprofileを検証し、新しい未統合依存を飛ばして開始できない", async () => {
  const { app, call, repoId } = await fixture();
  try {
    const dep = await call("task.create", { repoId, spec }),
      task = await call("task.create", { repoId, spec });
    const taskId = text(task.id);
    app.store.db
      .prepare("UPDATE tasks SET state='changes_required' WHERE id=?")
      .run(taskId);
    await assert.rejects(
      call(
        "task.revise",
        { taskId, spec: { ...spec, implementerProfile: "missing" } },
        number(task.version),
      ),
      (error: unknown) => object(error).code === "PROFILE_UNAVAILABLE",
    );
    assert.equal(
      (await call("task.get", { taskId })).state,
      "changes_required",
    );
    const revised = await call(
      "task.revise",
      { taskId, spec: { ...spec, dependsOn: [dep.id!] } },
      number(task.version),
    );
    assert.equal(revised.state, "ready");
    assert.equal(
      (
        app.store.db
          .prepare(
            "SELECT dependency_id FROM task_dependencies WHERE task_id=?",
          )
          .get(taskId) as { dependency_id: string }
      ).dependency_id,
      dep.id,
    );
    await assert.rejects(
      call("task.start", { taskId }, number(revised.version)),
      (error: unknown) => object(error).code === "DEPENDENCY_UNRESOLVED",
    );
    app.store.db
      .prepare("UPDATE tasks SET state='changes_required' WHERE id=?")
      .run(text(dep.id));
    await assert.rejects(
      call(
        "task.revise",
        { taskId: dep.id!, spec: { ...spec, dependsOn: [taskId] } },
        number(dep.version),
      ),
      (error: unknown) => object(error).code === "DEPENDENCY_CYCLE",
    );
  } finally {
    app.close();
  }
});

test("daemon継続処理を失ったstageを起動時に復旧待ちへ移し、世代を増やして再試行する", async () => {
  const { home, app, call, repoId } = await fixture();
  const task = await call("task.create", { repoId, spec });
  const taskId = text(task.id);
  app.store.db
    .prepare("UPDATE tasks SET state='freezing' WHERE id=?")
    .run(taskId);
  app.close();
  const restarted = createWorkbench(home);
  try {
    const row = restarted.store.db
      .prepare("SELECT state,version,generation FROM tasks WHERE id=?")
      .get(taskId) as { state: string; version: number; generation: number };
    assert.equal(row.state, "recovery_required");
    const recover = async (params: { [key: string]: Json }) =>
      object(
        await restarted.dispatch(
          {
            schemaVersion: 1,
            requestId: id("req"),
            method: "task.recover",
            expectedVersion: row.version,
            params,
          },
          actor,
        ),
      );
    const plan = await recover({ taskId });
    const ready = await recover({ taskId, planDigest: plan.planDigest! });
    assert.equal(ready.state, "ready");
    assert.equal(ready.generation, row.generation + 1);
  } finally {
    restarted.close();
  }
});
