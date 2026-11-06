import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ArtifactStore,
  CheckRequest,
  CheckResult,
  Result,
} from "../../../contracts/ports.js";
import { ok, fail, asError, unwrap } from "../../domain/errors.js";
import { readConfig, fixtureTest } from "../../application/config.js";
import { childEnvironment } from "../os/paths.js";
export function fixtureCheckRunner(home: string, artifacts: ArtifactStore) {
  return {
    async execute(
      request: CheckRequest,
      signal: AbortSignal,
    ): Promise<Result<CheckResult>> {
      try {
        if (
          !readConfig(home).devFixtures ||
          !resolve(request.cwd).startsWith(resolve(home, "workspaces") + "/")
        )
          return fail(
            "SIMULATED_EVIDENCE_FORBIDDEN",
            "fixture用home以外ではhost runnerを使えません",
          );
        if (
          request.argv.length !== 3 ||
          request.argv[0] !== process.execPath ||
          request.argv[1] !== "--test" ||
          request.argv[2] !== "test/add.test.js"
        )
          return fail(
            "FIXTURE_COMMAND_DENIED",
            "既知fixtureのNodeテストだけが許可されています",
          );
        const implementation = readFileSync(
          join(request.cwd, "src/add.js"),
          "utf8",
        );
        if (
          ![
            "export const add = (a, b) => a - b;\n",
            "export const add = (a, b) => a + b;\n",
          ].includes(implementation)
        )
          return fail(
            "FIXTURE_COMMAND_DENIED",
            "未知のコードをhostで実行できません",
          );
        const test = readFileSync(
          join(request.cwd, "test/add.test.js"),
          "utf8",
        );
        if (test !== fixtureTest)
          return fail(
            "FIXTURE_COMMAND_DENIED",
            "fixtureテストが改変されています",
          );
        const cleanHome = join(
          home,
          "workers",
          request.attemptId,
          "check-home",
        );
        mkdirSync(cleanHome, { recursive: true, mode: 0o700 });
        const result = await new Promise<{
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          bytes: Buffer;
        }>((resolveResult, reject) => {
          const child = spawn(request.argv[0]!, request.argv.slice(1), {
            cwd: request.cwd,
            env: childEnvironment(cleanHome),
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
          let length = 0,
            timedOut = false,
            oversized = false;
          const chunks: Buffer[] = [];
          const stop = () => {
            if (child.pid)
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch (error) {
                if (
                  !(
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === "ESRCH"
                  )
                )
                  reject(error);
              }
          };
          const timeout = setTimeout(() => {
            timedOut = true;
            stop();
          }, request.timeoutMs);
          signal.addEventListener("abort", stop, { once: true });
          const data = (chunk: Buffer) => {
            length += chunk.length;
            if (length > request.maxOutputBytes) {
              oversized = true;
              stop();
            } else chunks.push(chunk);
          };
          child.stdout.on("data", data);
          child.stderr.on("data", data);
          child.once("error", reject);
          child.once("close", (code, termination) => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", stop);
            if (oversized)
              reject({
                code: "LOG_CAPACITY_EXCEEDED",
                message: "checkの出力上限を超えました",
              });
            else
              resolveResult({
                exitCode: code,
                signal: termination,
                timedOut,
                bytes: Buffer.concat(chunks),
              });
          });
        });
        const output = unwrap(
          await artifacts.put(
            result.bytes,
            "text/plain",
            request.maxOutputBytes,
          ),
        );
        const sourceUnchanged =
          implementation ===
            readFileSync(join(request.cwd, "src/add.js"), "utf8") &&
          test === readFileSync(join(request.cwd, "test/add.test.js"), "utf8");
        return ok({
          attemptId: request.attemptId,
          candidateIdentityDigest: request.candidateIdentityDigest,
          checkId: request.checkId,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          sourceUnchanged,
          isolationVerified: false,
          simulated: true,
          output,
          outputs: [],
        });
      } catch (error) {
        return { ok: false, error: asError(error) };
      }
    },
  };
}
