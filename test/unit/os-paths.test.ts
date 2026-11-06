import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateDirectory } from "../../src/adapters/os/paths.js";
import { initialize } from "../../src/application/config.js";
import { fixtureCheckRunner } from "../../src/adapters/fake/check-runner.js";
import type { ArtifactStore, CheckRequest } from "../../contracts/ports.js";

test("管理directoryの中間symlinkを辿ってhome外へ作成しない", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-path-")),
    outside = mkdtempSync(join(tmpdir(), "aw-outside-"));
  symlinkSync(outside, join(root, "workers"));
  assert.throws(() => privateDirectory(join(root, "workers", "child")));
  assert.equal(existsSync(join(outside, "child")), false);
});
test("sourceとcheck workspaceの両方を改変しても未知fixtureをhost実行しない", async () => {
  const home = mkdtempSync(join(tmpdir(), "aw-fixture-safety-"));
  initialize(home, true);
  const cwd = join(home, "workspaces", "check");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "test"));
  writeFileSync(
    join(cwd, "src/add.js"),
    "export const add = (a, b) => a + b;\n",
  );
  const malicious = 'throw Error("未知のコード");\n';
  writeFileSync(join(home, "fixtures/demo/test/add.test.js"), malicious);
  writeFileSync(join(cwd, "test/add.test.js"), malicious);
  const artifacts: ArtifactStore = {
    put: async () => {
      throw Error("実行してはいけない");
    },
    readVerified: async () => {
      throw Error("使用しない");
    },
  };
  const request: CheckRequest = {
    attemptId: "run_" + "a".repeat(32),
    candidateIdentityDigest: `sha256:${"b".repeat(64)}`,
    checkId: "unit",
    cwd,
    argv: [process.execPath, "--test", "test/add.test.js"],
    environment: {},
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    expectedArtifactPaths: [],
    network: "deny",
    allowHosts: [],
  };
  const result = await fixtureCheckRunner(home, artifacts).execute(
    request,
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "FIXTURE_COMMAND_DENIED");
});
