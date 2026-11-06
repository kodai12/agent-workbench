import { createServer } from "node:net";
import {
  readFileSync,
  openSync,
  closeSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { unwrap, asError } from "../domain/errors.js";
import { appendSpool } from "../adapters/filesystem/spool.js";
import { object, text, list, record } from "../application/data.js";
import { processStartIdentity } from "../daemon/lifecycle.js";
import { bytesDigest, digest } from "../domain/canonical.js";
import { atomicWrite } from "../adapters/os/paths.js";
import { validateContract, parseJson } from "../contracts/loader.js";
import type { Json } from "../../contracts/ports.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { ticket: { type: "string" } } });
  if (!values.ticket)
    throw { code: "INVALID_INPUT", message: "ticketが必要です" };
  const path = values.ticket,
    dir = dirname(path),
    ticket = record(readFileSync(path, "utf8"));
  const attemptId = text(ticket.attemptId),
    workerInstanceId = text(ticket.workerInstanceId),
    nonce = text(ticket.nonce),
    cwd = text(ticket.cwd),
    role = text(ticket.role);
  const claim = openSync(join(dir, "claimed"), "wx", 0o600);
  closeSync(claim);
  let seq = 0,
    cancelled = false;
  const emit = async (type: string, data: Record<string, Json>) => {
    const envelope = {
      schemaVersion: 1,
      attemptId,
      workerInstanceId,
      sourceSeq: ++seq,
      occurredAtMs: Date.now(),
      type,
      data,
    };
    unwrap(
      await appendSpool(
        join(dir, "events.jsonl"),
        envelope,
        Number(ticket.maxLogBytes),
      ),
    );
  };
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 65536) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const parsed = parseJson(buffer.slice(0, newline));
      if (!parsed.ok) {
        socket.end(JSON.stringify({ ok: false }) + "\n");
        return;
      }
      const request = object(parsed.value);
      if (request.nonce !== nonce) {
        socket.end(
          JSON.stringify({ ok: false, error: "PERMISSION_DENIED" }) + "\n",
        );
        return;
      }
      if (request.method === "cancel") cancelled = true;
      if (!["status", "cancel"].includes(String(request.method))) {
        socket.end(
          JSON.stringify({ ok: false, error: "UNSUPPORTED_OPERATION" }) + "\n",
        );
        return;
      }
      socket.end(
        JSON.stringify({
          ok: true,
          attemptId,
          workerInstanceId,
          pid: process.pid,
          cancelled,
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(text(ticket.workerSocket), resolve);
  });
  chmodSync(text(ticket.workerSocket), 0o600);
  atomicWrite(
    join(dir, "identity.json"),
    JSON.stringify({
      attemptId,
      workerInstanceId,
      pid: process.pid,
      startedAtMs: Date.now(),
    }),
  );
  try {
    await emit("worker.ready", {
      protocolVersion: 1,
      workerSocket: text(ticket.workerSocket),
      pid: process.pid,
      startIdentity: processStartIdentity(process.pid),
      capabilities: ["fixture-only"],
    });
    await emit("run.started", {
      threadId: null,
      turnId: null,
      profileDigest: digest({ driver: "fake" }),
    });
    if (ticket.driver !== "fake" || ticket.fixture !== true)
      throw {
        code: "SANDBOX_UNVERIFIED",
        message: "未検証の実provider実行は禁止です",
      };
    if (!existsSync(join(cwd, "src/add.js")))
      throw { code: "FIXTURE_MISMATCH", message: "既知fixtureがありません" };
    if (cancelled) {
      await emit("run.cancelled", {
        reason: "human-request",
        processQuiescent: true,
      });
      return;
    }
    const packet = record(readFileSync(text(ticket.packetPath), "utf8"));
    let output: Json;
    if (role === "implement") {
      atomicWrite(
        join(cwd, "src/add.js"),
        "export const add = (a, b) => a + b;\n",
      );
      output = {
        schemaVersion: 1,
        summary: "既知fixtureの加算を修正",
        declaredOutcome: "ready_for_verification",
        changedPaths: ["src/add.js"],
        requirementsAddressed: list(packet.requirements).map((v) =>
          text(object(v).id),
        ),
        testsClaimed: [],
        knownLimitations: ["fake providerによる模擬実行"],
        questionForHuman: null,
      };
    } else if (role === "review") {
      output = {
        schemaVersion: 1,
        verdict: "pass",
        summary: "既知fixtureの変更を模擬確認",
        findings: [],
        coverage: list(packet.changedPaths).map((v) => ({
          path: text(v),
          status: "complete",
          reason: "fixture全変更範囲を確認",
        })),
        requirementCoverage: list(packet.requirements).map((v) => ({
          requirementId: text(object(v).id),
          status: "supported",
          evidence: [
            {
              kind: "file",
              reference: "src/add.js",
              digest: null,
              startLine: 1,
              endLine: 1,
              explanation: "候補はa+bを返す",
            },
          ],
        })),
        openQuestions: [],
      };
    } else
      throw {
        code: "UNSUPPORTED_OPERATION",
        message: "このworker roleは未対応です",
      };
    unwrap(
      validateContract(
        role === "review" ? "review-output" : "implementation-output",
        output,
      ),
    );
    atomicWrite(join(dir, "output.json"), JSON.stringify(output));
    await emit("run.completed", {
      outputDigest: bytesDigest(readFileSync(join(dir, "output.json"))),
      finishReason: "completed",
      processQuiescent: true,
    });
  } catch (error) {
    await emit("run.failed", {
      code: asError(error).code,
      message: asError(error).message,
      partialOutputDigest: null,
      retryability: "never",
    });
    process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().catch((error) => {
  console.error(JSON.stringify(asError(error)));
  process.exitCode = 1;
});
