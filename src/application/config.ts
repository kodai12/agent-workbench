import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Json } from "../../contracts/ports.js";
import {
  atomicWrite,
  privateDirectory,
  executable,
  childEnvironment,
} from "../adapters/os/paths.js";
import { object, record } from "./data.js";
export const fixtureTest =
  'import assert from "node:assert/strict"; import {test} from "node:test"; import {add} from "../src/add.js"; test("加算",()=>{assert.equal(add(2,3),5);assert.equal(add(-1,1),0);});\n';
export type Config = {
  schemaVersion: 1;
  devFixtures: boolean;
  profiles: { [key: string]: Json };
};
export function readConfig(home: string): Config {
  const value = record(readFileSync(join(home, "config.json"), "utf8"));
  if (value.schemaVersion !== 1 || typeof value.devFixtures !== "boolean")
    throw { code: "INVALID_INPUT", message: "設定形式が不正です" };
  return {
    schemaVersion: 1,
    devFixtures: value.devFixtures,
    profiles: object(value.profiles),
  };
}
export function saveConfig(home: string, config: Config): void {
  atomicWrite(
    join(home, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}
export function initialize(
  home: string,
  fixtures: boolean,
): { home: string; codexHome: string; fixture: string | null } {
  home = resolve(home);
  privateDirectory(home);
  home = realpathSync(home);
  if (existsSync(join(home, "config.json")))
    throw {
      code: "ALREADY_INITIALIZED",
      message: "既存のhomeは上書きしません",
    };
  for (const dir of [
    "objects",
    "repos",
    "workspaces",
    "workers",
    "backups",
    "exports",
    "protocol-captures",
    "credentials/codex",
    "session-cwd",
  ])
    privateDirectory(join(home, dir));
  const profiles: { [key: string]: Json } = {};
  if (fixtures) {
    for (const name of [
      "fake-coding",
      "fake-review-a",
      "fake-review-b",
      "fake-board-a",
      "fake-board-b",
    ])
      profiles[name] = {
        driver: "fake",
        providerId: "fake",
        trainingFamily: "fixture",
        modelId: null,
        reasoningEffort: null,
        maxOutputTokens: 4000,
        contextBytesLimit: 524288,
      };
  }
  saveConfig(home, { schemaVersion: 1, devFixtures: fixtures, profiles });
  atomicWrite(join(home, "control-token"), randomBytes(32).toString("hex"));
  const source = fixtures ? join(home, "fixtures", "demo") : null;
  if (source) {
    privateDirectory(source);
    privateDirectory(join(source, "src"));
    privateDirectory(join(source, "test"));
    atomicWrite(join(source, "package.json"), '{"type":"module"}\n');
    atomicWrite(
      join(source, "src/add.js"),
      "export const add = (a, b) => a - b;\n",
    );
    atomicWrite(join(source, "test/add.test.js"), fixtureTest);
    const git = executable("git");
    const env = childEnvironment(home, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Agent Workbench",
      GIT_AUTHOR_EMAIL: "local@agent-workbench.invalid",
      GIT_COMMITTER_NAME: "Agent Workbench",
      GIT_COMMITTER_EMAIL: "local@agent-workbench.invalid",
    });
    for (const args of [
      ["init", "--initial-branch=main", source],
      [
        "-C",
        source,
        "-c",
        "core.hooksPath=/dev/null",
        "add",
        "--",
        "package.json",
        "src/add.js",
        "test/add.test.js",
      ],
      [
        "-C",
        source,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture: 加算の既知不具合",
      ],
    ]) {
      const result = spawnSync(git, args, { env, encoding: "utf8" });
      if (result.status !== 0)
        throw { code: "FIXTURE_CREATION_FAILED", message: result.stderr };
    }
    const result = spawnSync(git, ["-C", source, "rev-parse", "HEAD"], {
      env,
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw { code: "FIXTURE_CREATION_FAILED", message: result.stderr };
    atomicWrite(
      join(home, "fixtures", "identity.json"),
      JSON.stringify({ sourcePath: source, baseSha: result.stdout.trim() }),
    );
  }
  return { home, codexHome: join(home, "credentials/codex"), fixture: source };
}
