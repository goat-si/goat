// @effect-diagnostics-next-line nodeBuiltinImport:off -- narrow non-inheriting Git process boundary.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- acquisition validates absolute server paths.
import * as NodePath from "node:path";
import { MemoryImportRpcError, type MemoryImportIssue } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { MemoryImportReaderConfig } from "./MemoryImportReader.ts";

const PROCESS_TIMEOUT = 10_000;
const error = (issue: MemoryImportIssue) => new MemoryImportRpcError({ issue });

// Aside semantic page directories. Briefings (MEMORY.md, USER.md), episodic/ and routines/ logs,
// run logs, vector indexes and dot-directories live elsewhere in the store and are never listed.
export const ASIDE_DIRECTORIES = [
  "agent",
  "concepts",
  "projects",
  "sites",
  "people",
  "companies",
  "users",
] as const;
export const asidePage = (name: string) =>
  name.endsWith(".md") &&
  !name.startsWith(".") &&
  name !== "MEMORY.md" &&
  name !== "USER.md" &&
  !/^\d{4}-\d{2}-\d{2}/.test(name);
/** Aside selections are `<store slot>:<semantic directory>`; slot names never contain "/". */
export const asideSelection = (selection: string) => {
  const at = selection.lastIndexOf(":");
  const directory = selection.slice(at + 1);
  if (at < 1 || !(ASIDE_DIRECTORIES as readonly string[]).includes(directory))
    throw error("path_rejected");
  return { slot: selection.slice(0, at), directory };
};

export const safe = (value: string) => {
  if (
    !value ||
    Buffer.byteLength(value) > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw error("path_rejected");
  if (scanMemoryValue(value).kind === "blocked") throw error("secret_detected");
};
export const absolute = (path: string) => {
  if (!NodePath.isAbsolute(path) || path === "/" || NodePath.normalize(path) !== path)
    throw error("path_rejected");
  safe(path.slice(NodePath.parse(path).root.length).split(NodePath.sep).join("/"));
};

export const validateStateBoundary = (config: MemoryImportReaderConfig) => {
  const within = (parent: string, path: string) => {
    const relative = NodePath.relative(parent, path);
    return (
      relative === "" ||
      (!NodePath.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`))
    );
  };
  for (const root of config.roots) {
    absolute(root.path);
    if (within(root.path, config.stateDir) || within(config.stateDir, root.path))
      throw error("path_rejected");
    if (config.gitExecutable && within(root.path, config.gitExecutable))
      throw error("path_rejected");
  }
};

/** A complete map: Node spawn's env replaces inheritance; host env is never enumerated. */
const environment = (cwd: string, gitDir?: string) => ({
  PATH: "/usr/bin:/bin",
  HOME: cwd,
  XDG_CONFIG_HOME: cwd,
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "",
  ...(gitDir ? { GIT_DIR: gitDir } : {}),
});

// Owned process finishes (including timeout/interruption) before snapshot cleanup can run.
export const execute = (
  executable: string,
  args: readonly string[],
  cwd: string,
  maxBytes: number,
  gitDir?: string,
  onSpawn?: (pid: number) => void,
) =>
  Effect.callback<{ code: number; bytes: Buffer }, MemoryImportRpcError>((resume) => {
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      child = NodeChildProcess.spawn(executable, [...args], {
        cwd,
        env: environment(cwd, gitDir),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resume(Effect.fail(error("source_unreadable")));
      return;
    }
    child.stdin.end();
    let size = 0;
    let failed = false;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    // @effect-diagnostics-next-line globalTimersInEffect:off -- owned OS-process watchdog; interruption waits for close, never polls.
    const timer = setTimeout(stop, PROCESS_TIMEOUT);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop();
      else chunks.push(chunk);
    });
    // Never retain or expose stderr. It has the same bound, independent of stdout.
    let stderr = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > maxBytes) stop();
    });
    child.on("error", () => {
      failed = true;
    });
    let ended = false;
    const waiters: (() => void)[] = [];
    child.on("close", (code) => {
      ended = true;
      clearTimeout(timer);
      for (const waiter of waiters) waiter();
      resume(
        failed
          ? Effect.fail(error("source_unreadable"))
          : Effect.succeed({ code: code ?? -1, bytes: Buffer.concat(chunks) }),
      );
    });
    try {
      if (child.pid !== undefined) onSpawn?.(child.pid);
    } catch {
      stop();
    }
    return Effect.callback<void>((done) => {
      if (ended) done(Effect.void);
      else {
        waiters.push(() => done(Effect.void));
        stop();
      }
    });
  });
