import {
  constants,
  accessSync,
  realpathSync,
  lstatSync,
  statSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
export function defaultHome(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "agent-workbench")
    : join(
        process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
        "agent-workbench",
      );
}
export function privateDirectory(path: string): void {
  for (
    let current = resolve(path);
    current !== dirname(current);
    current = dirname(current)
  ) {
    try {
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() &&
        !(
          (current === "/tmp" && realpathSync(current) === "/private/tmp") ||
          (current === "/var" && realpathSync(current) === "/private/var")
        )
      )
        throw {
          code: "UNSAFE_HOME",
          message: "管理用directoryの親がsymlinkです",
        };
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (
    lstatSync(path).isSymbolicLink() ||
    statSync(path).uid !== process.getuid?.()
  )
    throw {
      code: "UNSAFE_HOME",
      message: "利用者が所有する通常directoryが必要です",
    };
  chmodSync(path, 0o700);
}
export function atomicWrite(path: string, value: string): void {
  privateDirectory(dirname(path));
  const temp = join(dirname(path), ".tmp-" + randomUUID());
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function executable(name: string): string {
  if (name.includes("/")) {
    const path = realpathSync(resolve(name));
    accessSync(path, constants.X_OK);
    return path;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      const path = realpathSync(join(dir, name));
      if (statSync(path).isFile()) {
        accessSync(path, constants.X_OK);
        return path;
      }
    } catch {}
  }
  throw {
    code: "PROVIDER_UNAVAILABLE",
    message: `実行ファイルが見つかりません: ${name}`,
  };
}
export const binaryDigest = (path: string): string =>
  "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
export function childEnvironment(
  home: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ...extra,
  };
}
export const id = (prefix: string): string =>
  prefix + "_" + randomUUID().replaceAll("-", "");
export const sanitize = (value: string): string =>
  value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
