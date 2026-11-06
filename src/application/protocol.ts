import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../../contracts/ports.js";
import { bytesDigest } from "../domain/canonical.js";
import { record, object, text, list } from "./data.js";

export function inspectProtocolLock(): Json {
  const root = dirname(
    fileURLToPath(new URL("../../protocol-lock.json", import.meta.url)),
  );
  try {
    const lock = record(readFileSync(join(root, "protocol-lock.json"), "utf8"));
    let files = 0;
    const recorded = new Set<string>();
    for (const entry of list(lock.captures).map(object)) {
      const path = text(entry.path);
      if (
        !path.startsWith("src/generated/") ||
        path.split("/").some((p) => p === ".." || p === "") ||
        recorded.has(path)
      )
        throw new Error("capture pathが不正です");
      recorded.add(path);
      if (bytesDigest(readFileSync(join(root, path))) !== entry.digest)
        throw new Error("capture digestが不一致です: " + path);
      files++;
    }
    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else {
          const name = relative(root, child);
          const source = name.endsWith(".d.ts")
            ? name.slice(0, -5) + ".ts"
            : name.endsWith(".js")
              ? name.slice(0, -3) + ".ts"
              : null;
          if (!recorded.has(name) && !(source && recorded.has(source)))
            throw new Error("未知のcapture fileがあります: " + name);
        }
      }
    };
    walk(join(root, "src/generated"));
    return {
      locked: true,
      files,
      codex: lock.codex ?? null,
      herdr: lock.herdr ?? null,
      liveVerified: false,
      strictSandboxVerified: false,
      issues: ["SANDBOX_UNVERIFIED: restricted readの契約と実canaryが未確認"],
    };
  } catch (error) {
    return {
      locked: false,
      liveVerified: false,
      strictSandboxVerified: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}
