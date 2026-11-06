import { createConnection } from "node:net";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../../contracts/ports.js";
import type { AttemptRow } from "./types.js";
import { record, object, text, number } from "./data.js";
import { parseJsonBytes } from "../contracts/loader.js";
import { unwrap } from "../domain/errors.js";

export async function controlWorker(
  home: string,
  attempt: AttemptRow,
  method: "status" | "cancel",
): Promise<Json> {
  const ticket = record(
    readFileSync(join(home, "workers", attempt.id, "ticket.json"), "utf8"),
  );
  if (
    ticket.attemptId !== attempt.id ||
    ticket.workerInstanceId !== attempt.worker_instance_id ||
    ticket.workerSocket !== attempt.worker_socket ||
    !attempt.worker_socket
  )
    throw {
      code: "WORKER_IDENTITY_MISMATCH",
      message: "予約したworker情報と一致しません",
    };
  const stat = lstatSync(attempt.worker_socket);
  if (
    !stat.isSocket() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw {
      code: "UNSAFE_CONTROL_PATH",
      message: "worker socketの所有者か権限が不正です",
    };
  return new Promise((resolve, reject) => {
    const socket = createConnection(attempt.worker_socket!);
    let bytes = Buffer.alloc(0),
      settled = false;
    const finish = (error: unknown, value: Json = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () =>
        finish({
          code: "EXECUTION_UNCERTAIN",
          message: "workerの制御応答を確認できません",
        }),
      2000,
    );
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ method, nonce: text(ticket.nonce) }) + "\n",
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65536) {
        finish({
          code: "PROTOCOL_VIOLATION",
          message: "worker応答が上限を超えました",
        });
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const value = object(
          unwrap(parseJsonBytes(bytes.subarray(0, newline))),
        );
        const identity = record(attempt.process_identity_json ?? "{}");
        if (
          value.ok !== true ||
          value.attemptId !== attempt.id ||
          value.workerInstanceId !== attempt.worker_instance_id ||
          value.pid !== number(identity.pid)
        )
          throw {
            code: "WORKER_IDENTITY_MISMATCH",
            message: "worker制御応答のidentityが一致しません",
          };
        finish(null, value);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", finish);
    socket.on("close", () =>
      finish({
        code: "EXECUTION_UNCERTAIN",
        message: "worker応答前に切断されました",
      }),
    );
  });
}
