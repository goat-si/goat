// Linux cgroup leases that let an ACP runtime own and stop its agent process tree.
// @effect-diagnostics nodeBuiltinImport:off
import { parseUnifiedCgroupPath, isSafeCgroupPath, parseCgroup2Mounts } from "./cgroupPaths.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RAISE_OOM_SCORE_LINE } from "@goat/shared/AgentScope";
import type {
  AcpPosixProcessIdentity,
  AcpPosixProcessTreeController,
  AcpLinuxCgroupLease,
  AcpLinuxCgroupController,
  AcpPosixOwnershipRoot,
} from "./AcpSessionRuntime.ts";

export class AcpProcessGroupTerminationError extends Schema.TaggedError<AcpProcessGroupTerminationError>()(
  "AcpProcessGroupTerminationError",
  {
    detail: Schema.String,
    pid: Schema.optionalKey(Schema.Int),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export function wrapCommandForLinuxCgroup(
  lease: AcpLinuxCgroupLease,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      [
        "lease_path=$1; expected=$2; shift 2",
        RAISE_OOM_SCORE_LINE,
        'printf "%s\\n" "$$" > "$lease_path/cgroup.procs" || exit 125',
        "actual=",
        "while IFS= read -r line; do",
        '  case "$line" in 0::*) [ -z "$actual" ] || exit 126; actual=${line#0::};; esac',
        "done < /proc/self/cgroup || exit 125",
        '[ "$actual" = "$expected" ] || exit 126',
        "unset ELECTRON_RUN_AS_NODE GOAT_ACP_CGROUP_WRAPPER",
        "trap 'exit 125' 0",
        // Bash can skip EXIT traps on failed exec; reject invalid targets with path and exit 125.
        '[ -f "$1" ] && [ -x "$1" ] || { printf "%s: %s: not an executable file\\n" "$0" "$1" >&2; exit 125; }',
        'exec "$@"',
      ].join("\n"),
      "t3-acp-cgroup-wrapper",
      lease.path,
      lease.relativePath,
      command,
      ...args,
    ],
  };
}

export function resolveLinuxCgroupTargetCommand(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  // Match Node spawn: only undefined PATH gets a fallback; empty PATH searches cwd.
  const pathEnv = environment.PATH === undefined ? "/usr/bin:/bin" : environment.PATH;
  const candidates = command.includes(NodePath.sep)
    ? [NodePath.resolve(cwd, command)]
    : pathEnv
        .split(NodePath.delimiter)
        .map((entry) =>
          NodePath.join(
            entry.length === 0
              ? cwd
              : NodePath.isAbsolute(entry)
                ? entry
                : NodePath.resolve(cwd, entry),
            command,
          ),
        );
  for (const candidate of candidates) {
    try {
      if (!NodeFS.statSync(candidate).isFile()) continue;
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

const STALE_ACP_CGROUP_SIBLING = /^t3-acp-(\d+)-/;

export interface SweepStaleLinuxCgroupSiblingsOptions {
  readonly currentPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly readPopulated?: (siblingPath: string) => "0" | "1" | undefined;
  readonly remove?: (siblingPath: string) => void;
}

function defaultCgroupOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

function defaultReadCgroupPopulated(siblingPath: string): "0" | "1" | undefined {
  const state = /(?:^|\n)populated ([01])(?:\n|$)/.exec(
    NodeFS.readFileSync(NodePath.join(siblingPath, "cgroup.events"), "utf8"),
  )?.[1];
  return state === "0" || state === "1" ? state : undefined;
}

export function sweepStaleLinuxCgroupSiblings(
  parentPath: string,
  options: SweepStaleLinuxCgroupSiblingsOptions = {},
): void {
  const currentPid = options.currentPid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultCgroupOwnerIsAlive;
  const readPopulated = options.readPopulated ?? defaultReadCgroupPopulated;
  const remove = options.remove ?? ((siblingPath: string) => NodeFS.rmdirSync(siblingPath));
  try {
    for (const entry of NodeFS.readdirSync(parentPath, { withFileTypes: true })) {
      try {
        if (!entry.isDirectory()) continue;
        const match = STALE_ACP_CGROUP_SIBLING.exec(entry.name);
        if (match === null) continue;
        const ownerPid = Number(match[1]);
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || ownerPid === currentPid) continue;
        if (isProcessAlive(ownerPid)) continue;
        const siblingPath = NodePath.join(parentPath, entry.name);
        if (NodePath.dirname(siblingPath) !== parentPath) continue;
        if (readPopulated(siblingPath) !== "0") continue;
        remove(siblingPath);
      } catch {}
    }
  } catch {}
}

function tryCreateLinuxCgroupLease(
  currentRelative: string,
  mount: { readonly mountPoint: string; readonly root: string },
): AcpLinuxCgroupLease | undefined {
  if (
    !isSafeCgroupPath(mount.root) ||
    !isSafeCgroupPath(mount.mountPoint) ||
    !(
      mount.root === "/" ||
      currentRelative === mount.root ||
      currentRelative.startsWith(`${mount.root}/`)
    )
  ) {
    return undefined;
  }
  const mountRelative =
    mount.root === "/" ? currentRelative : currentRelative.slice(mount.root.length);
  const currentPath = NodePath.resolve(mount.mountPoint, `.${mountRelative}`);
  const resolvedMount = NodePath.resolve(mount.mountPoint);
  if (currentPath !== resolvedMount && !currentPath.startsWith(`${resolvedMount}${NodePath.sep}`)) {
    return undefined;
  }
  sweepStaleLinuxCgroupSiblings(currentPath);
  const childName = `t3-acp-${process.pid}-${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const childPath = NodePath.join(currentPath, childName);
  const childRelative = NodePath.posix.join(currentRelative, childName);
  if (NodePath.dirname(childPath) !== currentPath) return undefined;
  try {
    NodeFS.mkdirSync(childPath, { mode: 0o700 });
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.procs"), NodeFS.constants.W_OK);
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.kill"), NodeFS.constants.W_OK);
    NodeFS.accessSync(NodePath.join(childPath, "cgroup.events"), NodeFS.constants.R_OK);
    if (NodeFS.readFileSync(NodePath.join(childPath, "cgroup.type"), "utf8").trim() !== "domain") {
      throw new Error("ACP cgroup is not a domain cgroup");
    }
    if (typeof process.execve !== "function") throw new Error("process.execve is unavailable");
  } catch {
    try {
      NodeFS.rmdirSync(childPath);
    } catch {}
    return undefined;
  }
  return {
    contains: (pid) =>
      parseUnifiedCgroupPath(NodeFS.readFileSync(`/proc/${pid}/cgroup`, "utf8")) === childRelative,
    exists: () => NodeFS.existsSync(childPath),
    path: childPath,
    relativePath: childRelative,
    kill: () => NodeFS.writeFileSync(NodePath.join(childPath, "cgroup.kill"), "1\n"),
    populated: () => {
      const state = /(?:^|\n)populated ([01])(?:\n|$)/.exec(
        NodeFS.readFileSync(NodePath.join(childPath, "cgroup.events"), "utf8"),
      )?.[1];
      if (state === undefined) throw new Error("ACP cgroup.events has no populated state");
      return state === "1";
    },
    remove: () => {
      const directories = (path: string): ReadonlyArray<string> =>
        NodeFS.readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? [...directories(NodePath.join(path, entry.name)), NodePath.join(path, entry.name)]
            : [],
        );
      for (const directory of directories(childPath)) NodeFS.rmdirSync(directory);
      NodeFS.rmdirSync(childPath);
    },
  };
}

export function makeLinuxCgroupController(): AcpLinuxCgroupController {
  return {
    create: () => {
      let currentRelative: string | undefined;
      let mounts: ReadonlyArray<{ readonly mountPoint: string; readonly root: string }> = [];
      try {
        currentRelative = parseUnifiedCgroupPath(NodeFS.readFileSync("/proc/self/cgroup", "utf8"));
        mounts = parseCgroup2Mounts(NodeFS.readFileSync("/proc/self/mountinfo", "utf8"));
      } catch {
        return undefined;
      }
      if (
        currentRelative === undefined ||
        !currentRelative.startsWith("/") ||
        mounts.length === 0
      ) {
        return undefined;
      }
      if (!isSafeCgroupPath(currentRelative)) return undefined;
      // Multi-mount hosts often list a read-only view before the delegated one.
      for (const mount of mounts) {
        const lease = tryCreateLinuxCgroupLease(currentRelative, mount);
        if (lease !== undefined) return lease;
      }
      return undefined;
    },
  };
}

// OS-state polls need wall time; TestClock sleep requires explicit advancement.
const wallClock = Clock.Clock.defaultValue();
export const withWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Clock.Clock, wallClock);

export function terminateLinuxCgroupLease(
  lease: AcpLinuxCgroupLease,
): Effect.Effect<void, AcpProcessGroupTerminationError> {
  const failure = (name: string, cause: unknown) =>
    new AcpProcessGroupTerminationError({
      cause,
      detail: `Failed to ${name} ACP cgroup ${lease.path}`,
    });
  return Effect.gen(function* () {
    let lastRemovalFailure: { readonly cause: unknown } | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!lease.exists()) return;
      const killed = yield* Effect.try(() => lease.kill()).pipe(Effect.result);
      if (Result.isFailure(killed)) {
        const cause = killed.failure.cause;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") return yield* failure("kill", cause);
        if (!lease.exists()) return;
        yield* Effect.sleep("10 millis");
        continue;
      }
      const populated = yield* Effect.try(() => lease.populated()).pipe(Effect.result);
      if (Result.isFailure(populated)) {
        const cause = populated.failure.cause;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" && !lease.exists()) return;
        if (code === "ENOENT") {
          yield* Effect.sleep("10 millis");
          continue;
        }
        return yield* failure("read state for", cause);
      }
      if (populated.success) {
        lastRemovalFailure = null;
        yield* Effect.sleep("10 millis");
        continue;
      }
      const removed = yield* Effect.try(() => lease.remove()).pipe(Effect.result);
      if (Result.isFailure(removed)) {
        const cause = removed.failure.cause;
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" && !lease.exists()) return;
        if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "ENOENT") {
          return yield* failure("remove", cause);
        }
        lastRemovalFailure = { cause };
      } else {
        lastRemovalFailure = null;
      }
      if (!lease.exists()) return;
      yield* Effect.sleep("10 millis");
    }
    if (lastRemovalFailure !== null) {
      return yield* failure("remove", lastRemovalFailure.cause);
    }
    return yield* new AcpProcessGroupTerminationError({
      detail: `ACP cgroup ${lease.path} remained present after cgroup cleanup`,
    });
  }).pipe(withWallClock);
}

export function signalLinuxCgroupRootTerm(input: {
  readonly controller: AcpPosixProcessTreeController;
  readonly lease: AcpLinuxCgroupLease;
  readonly root: AcpPosixOwnershipRoot;
}): void {
  const root = input.root.value;
  if (root === undefined) return;
  try {
    const observed = input.controller.identity(root.pid);
    if (!samePosixProcessIdentity(root, observed) || !input.lease.contains(root.pid)) return;
    input.controller.signalProcess(root.pid, "SIGTERM");
  } catch {}
}

export function samePosixProcessIdentity(
  expected: AcpPosixProcessIdentity,
  observed: AcpPosixProcessIdentity | undefined,
): boolean {
  return (
    observed !== undefined &&
    observed.pid === expected.pid &&
    observed.startTime === expected.startTime
  );
}
