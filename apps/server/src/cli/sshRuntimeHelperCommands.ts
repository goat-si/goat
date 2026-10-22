import {
  GOAT_ENVIRONMENT_PATH,
  LEGACY_ENVIRONMENT_PATH,
  GOAT_ACTIVITY_PATH,
  LEGACY_ACTIVITY_PATH,
} from "@goat/contracts/legacyT3Names";
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import {
  ExecutionEnvironmentDescriptor,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_DRAIN_PATH,
  ORCHESTRATION_PROTOCOL_VERSION,
  RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
  RUNTIME_DRAIN_MAX_GRACE_SECONDS,
  RuntimeDrainResult,
} from "@goat/contracts";
import { compareRuntimeBuilds } from "@goat/shared/semver";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  encodePowerShellCommand,
  WINDOWS_DETACHED_SPAWN_POWERSHELL,
} from "@goat/shared/windowsHostProcess";
import {
  compareRuntimeProtocols,
  ownRuntimeProtocolRanges,
  type RuntimeProtocolVerdict,
  SSH_RUNTIME_PROTOCOL_VERSION,
} from "@goat/shared/sshRuntimeProtocol";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  SSH_REPLACEMENT_ID_ENV,
  sshReplacementOwner,
  sshSupervisorOwner,
} from "../serverOwnerLock.ts";
import { tryAcquireServerOwnerLock } from "../serverOwnerLockFile.ts";
import { ownRuntimeManifest } from "@goat/shared/runtimeManifest";
import { BUILD_COMMIT_TIME } from "../buildCommitTime.ts";
import packageJson from "../../package.json" with { type: "json" };

const decodeRuntimeState = Schema.decodeUnknownSync(PersistedServerRuntimeState);
const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

export const ownSshRuntimeProtocol = () => ({
  serverVersion: packageJson.version,
  sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
});

const readProtocolDescriptor = (port: number) =>
  new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (cause !== undefined) reject(cause);
      else resolve(value);
    };
    let request: NodeHttp.ClientRequest;
    const send = (path: string) => {
      request = NodeHttp.get({ hostname: "127.0.0.1", port, path, timeout: 1000 }, (response) => {
        if (response.statusCode === 404 && path === GOAT_ENVIRONMENT_PATH) {
          response.resume();
          send(LEGACY_ENVIRONMENT_PATH);
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            const cause = new Error("SSH runtime descriptor exceeds 64 KiB");
            response.destroy(cause);
            request.destroy(cause);
            finish(cause);
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", finish);
        response.once("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error("SSH runtime descriptor unavailable");
            // The live descriptor is decoded by the caller.
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (cause) {
            finish(cause);
          }
        });
      });
      request.once("timeout", () => {
        const cause = new Error("SSH descriptor timed out");
        request.destroy(cause);
        finish(cause);
      });
      request.once("error", finish);
    };
    const deadline = setTimeout(() => {
      const cause = new Error("SSH descriptor deadline exceeded");
      request.destroy(cause);
      finish(cause);
    }, 1500);
    send(GOAT_ENVIRONMENT_PATH);
  });

const protocolVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
const protocolInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/**
 * An exited server that nothing reaps (PID 1 in a container without an init) stays a zombie
 * and still answers signal 0, but it serves nothing and holds no locks.
 */
export const isLinuxZombie = (
  pid: number,
  readStat: (file: string) => string = (file) => NodeFS.readFileSync(file, "utf8"),
) => {
  try {
    const stat = readStat(`/proc/${pid}/stat`);
    // The command name in parentheses may itself contain ") Z", so read after the last one.
    return stat
      .slice(stat.lastIndexOf(")") + 1)
      .trimStart()
      .startsWith("Z");
  } catch {
    return false;
  }
};
const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
  return !isLinuxZombie(pid);
};
const hasLoopbackListener = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (present: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(present);
    };
    const deadline = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
const rememberedInteger = (file: string | undefined) => {
  if (file === undefined || !NodeFS.existsSync(file)) return 0;
  const raw = NodeFS.readFileSync(file, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Invalid remembered SSH identity");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid remembered SSH identity");
  return value;
};

export const readLiveSshRuntimeProtocol = async (
  runtimeFile: string,
  portFile?: string,
  pidFile?: string,
) => {
  let pid = 0;
  let port = 0;
  let record: typeof PersistedServerRuntimeState.Type | undefined;
  let damaged = false;
  try {
    if (NodeFS.existsSync(runtimeFile)) {
      // Decode the persisted shape before treating it as identity.
      record = decodeRuntimeState(JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")));
      const origin = new URL(record.origin);
      if (
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        !Number.isSafeInteger(record.port) ||
        record.port < 1 ||
        record.port > 65535 ||
        origin.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(origin.hostname) ||
        Number(origin.port || "80") !== record.port
      )
        throw new Error("Invalid runtime identity");
      pid = !record.serviceManaged && processExists(record.pid) ? record.pid : 0;
      port = record.port;
    }
  } catch {
    record = undefined;
    damaged = true;
  }
  let rememberedPid = 0;
  let rememberedDisagrees = false;
  try {
    if (port === 0) port = rememberedInteger(portFile);
    rememberedPid = rememberedInteger(pidFile);
    const rememberedPort = rememberedInteger(portFile);
    rememberedDisagrees =
      record !== undefined &&
      ((rememberedPort > 0 && rememberedPort !== record.port) ||
        (rememberedPid > 0 && rememberedPid !== record.pid));
    if (port > 65535) throw new Error("Invalid remembered port");
  } catch {
    damaged = true;
    port = 0;
  }
  const rememberedAlive = rememberedPid > 0 && processExists(rememberedPid);
  // Launch files left by an earlier server (or another client's earlier launch)
  // are stale once their PID is gone; the live record and descriptor decide.
  // They never grant ownership: the launch script requires its PID file to
  // name the live PID. A remembered PID that is still alive is a second claim.
  if (rememberedDisagrees && rememberedAlive) damaged = true;
  const unknown = { status: "unknown", pid, port } as const;
  if (port === 0)
    return damaged || rememberedAlive ? unknown : ({ status: "none", pid: 0, port: 0 } as const);
  let raw: unknown;
  try {
    raw = await readProtocolDescriptor(port);
  } catch {
    // A root HTTP response or living PID is not compatibility evidence.
    if (damaged || pid > 0 || rememberedAlive || (await hasLoopbackListener(port))) return unknown;
    return { status: "none", pid: 0, port: 0 } as const;
  }
  try {
    const descriptor = decodeEnvironmentDescriptor(raw);
    if (!protocolVersion(descriptor.serverVersion)) return unknown;
    for (const field of ["sshRuntimeProtocolVersion", "orchestrationProtocolVersion"] as const) {
      const value = descriptor[field];
      if (value !== undefined && !protocolInteger(value)) return unknown;
    }
    if (damaged) return unknown;
    if (record !== undefined) {
      for (const field of [
        "serverVersion",
        "sshRuntimeProtocolVersion",
        "orchestrationProtocolVersion",
      ] as const) {
        // Old format-1 absence is allowed; disagreement with a present field is not.
        if (record[field] !== undefined && record[field] !== descriptor[field]) return unknown;
      }
    }
    // Reread after HTTP: a changed persisted PID/port/version cannot authorize ownership.
    if (record !== undefined) {
      const current = decodeRuntimeState(JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")));
      for (const field of [
        "pid",
        "port",
        "origin",
        "startedAt",
        "serviceManaged",
        "serverVersion",
        "sshRuntimeProtocolVersion",
        "orchestrationProtocolVersion",
      ] as const) {
        if (current[field] !== record[field]) return unknown;
      }
      // Historical records still support live exact-version reuse, but do not grant kill authority.
      if (record.serverVersion === undefined || !processExists(record.pid)) pid = 0;
    }
    // No record/dead/unversioned PID means an answering port is external.
    return {
      status: "live",
      pid,
      port,
      serverVersion: descriptor.serverVersion,
      sshRuntimeProtocolVersion: descriptor.sshRuntimeProtocolVersion,
      orchestrationProtocolVersion: descriptor.orchestrationProtocolVersion,
    } as const;
  } catch {
    return unknown;
  }
};

declare const __GOAT_BUILD_COMMIT__: string | undefined;

const runtimeManifest = Command.make("runtime-manifest").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.sync(() => {
      const manifest = ownRuntimeManifest({
        version: packageJson.version,
        commit:
          typeof __GOAT_BUILD_COMMIT__ === "string" && __GOAT_BUILD_COMMIT__
            ? __GOAT_BUILD_COMMIT__
            : undefined,
        commitTime: BUILD_COMMIT_TIME,
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off - internal helper JSON output.
      process.stdout.write(JSON.stringify(manifest) + "\n");
    }),
  ),
);

const protocol = Command.make("protocol", {
  shell: Flag.Boolean("shell").pipe(Flag.withDefault(false)),
  runtimeFile: Flag.String("runtime-file").pipe(Flag.optional),
  portFile: Flag.String("port-file").pipe(Flag.optional),
  pidFile: Flag.String("pid-file").pipe(Flag.optional),
}).pipe(
  Command.withHandler(({ shell, runtimeFile, portFile, pidFile }) =>
    Effect.promise(async () => {
      try {
        const signals = Option.isSome(runtimeFile)
          ? await readLiveSshRuntimeProtocol(
              runtimeFile.value,
              Option.getOrUndefined(portFile),
              Option.getOrUndefined(pidFile),
            )
          : ownSshRuntimeProtocol();
        if (!shell) {
          // @effect-diagnostics-next-line preferSchemaOverJson:off - internal helper JSON output.
          process.stdout.write(JSON.stringify(signals) + "\n");
          return;
        }
        if ("serverVersion" in signals && !protocolVersion(signals.serverVersion)) {
          throw new Error("Invalid SSH protocol version token");
        }
        const version = "serverVersion" in signals ? signals.serverVersion : "unknown";
        const integer = (value: unknown) => (protocolInteger(value) ? String(value) : "unknown");
        const fields = [
          version,
          integer(
            "sshRuntimeProtocolVersion" in signals ? signals.sshRuntimeProtocolVersion : undefined,
          ),
          integer(
            "orchestrationProtocolVersion" in signals
              ? signals.orchestrationProtocolVersion
              : undefined,
          ),
          "pid" in signals ? signals.pid : 0,
          "port" in signals ? signals.port : 0,
        ];
        process.stdout.write(
          ("status" in signals ? signals.status + " " : "") + fields.join(" ") + "\n",
        );
      } catch (cause) {
        process.stderr.write(
          (cause instanceof Error ? cause.message : "Cannot inspect SSH protocol") + "\n",
        );
        process.exitCode = 1;
      }
    }),
  ),
);

export const readSshServerActivity = async (
  port: number,
  pid?: number,
): Promise<"idle" | "busy" | "unknown"> => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "unknown";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: "idle" | "busy" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve(value);
    };
    let request: NodeHttp.ClientRequest | undefined;
    const send = (path: string) => {
      request = NodeHttp.get({ hostname: "127.0.0.1", port, path }, (response) => {
        if (response.statusCode === 404 && path === GOAT_ACTIVITY_PATH) {
          response.resume();
          send(LEGACY_ACTIVITY_PATH);
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) {
            finish("unknown");
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", () => finish("unknown"));
        response.once("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (
              response.statusCode !== 200 ||
              !value ||
              !["idle", "busy"].includes(value.activity) ||
              !protocolVersion(value.serverVersion) ||
              !protocolInteger(value.pid) ||
              (pid !== undefined && value.pid !== pid)
            )
              finish("unknown");
            else finish(value.activity);
          } catch {
            finish("unknown");
          }
        });
      });
      request.once("error", () => finish("unknown"));
    };
    const deadline = setTimeout(() => finish("unknown"), 1500);
    send(GOAT_ACTIVITY_PATH);
  });
};

const activity = Command.make("activity", {
  port: Flag.Int("port"),
  pid: Flag.Int("pid").pipe(Flag.optional),
  shell: Flag.Boolean("shell").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler(({ port, pid }) =>
    Effect.promise(async () => {
      const value = await readSshServerActivity(port, Option.getOrUndefined(pid));
      process.stdout.write(value + "\n");
    }),
  ),
);

/**
 * Orders the live build against the requested one for the pinned SSH replacement candidate.
 * Prints `older`, `newer`, `equal`, or `unknown` when nothing proves an order
 * (see `compareRuntimeBuilds`).
 */
const compareVersion = Command.make("compare-version", {
  live: Argument.String("live-version"),
  requested: Argument.String("requested-version"),
  liveCommitTime: Flag.Int("live-commit-time").pipe(Flag.optional),
  requestedCommitTime: Flag.Int("requested-commit-time").pipe(Flag.optional),
}).pipe(
  Command.withHandler(({ live, requested, liveCommitTime, requestedCommitTime }) =>
    Effect.sync(() => {
      if (!protocolVersion(live) || !protocolVersion(requested)) {
        process.stderr.write("Invalid SSH version comparison tokens.\n");
        process.exitCode = 1;
        return;
      }
      const comparison = compareRuntimeBuilds(
        { version: live, commitTime: Option.getOrUndefined(liveCommitTime) },
        { version: requested, commitTime: Option.getOrUndefined(requestedCommitTime) },
      );
      process.stdout.write(
        (comparison === undefined
          ? "unknown"
          : comparison < 0
            ? "older"
            : comparison > 0
              ? "newer"
              : "equal") + "\n",
      );
    }),
  ),
);

/** Prints this build's commit time in Unix seconds; exits 1 for an unstamped build. */
const commitTime = Command.make("commit-time").pipe(
  Command.withHandler(() =>
    Effect.sync(() => {
      if (BUILD_COMMIT_TIME === undefined) process.exitCode = 1;
      else process.stdout.write(`${BUILD_COMMIT_TIME}\n`);
    }),
  ),
);

const instanceToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value);

/**
 * What the launch script needs to decide between attach, replace and refuse for the server on
 * `port`: the protocol-range verdict from the one comparator, whether it can drain for a
 * replacement, and the start it would drain. Servers without `drainRestart` or an
 * `instanceId` are attach-only.
 */
export const readSshRuntimeCompatibility = async (port: number) => {
  const descriptor = decodeEnvironmentDescriptor(await readProtocolDescriptor(port));
  const verdict = compareRuntimeProtocols(
    ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION),
    descriptor,
  );
  const instanceId = instanceToken(descriptor.instanceId) ? descriptor.instanceId : undefined;
  return {
    verdict,
    drainRestart: descriptor.capabilities.drainRestart === true && instanceId !== undefined,
    instanceId,
    serverVersion: descriptor.serverVersion,
  } as const;
};

/** Prints `<verdict> <drain 0|1> <instanceId|->`; exits 1 when no descriptor answers. */
const compat = Command.make("compat", {
  port: Flag.Int("port"),
}).pipe(
  Command.withHandler(({ port }) =>
    Effect.promise(async () => {
      try {
        const value = await readSshRuntimeCompatibility(port);
        process.stdout.write(
          `${value.verdict} ${value.drainRestart ? 1 : 0} ${value.instanceId ?? "-"}\n`,
        );
      } catch {
        process.stdout.write("unknown 0 -\n");
        process.exitCode = 1;
      }
    }),
  ),
);

/**
 * Asks the server on `port` to drain for `targetVersion`. Answers `drained` (it exits on its
 * own), `cancelled` (the grace window expired unconfirmed and it serves again),
 * `instance-changed`, or `unknown` when it gave no valid answer.
 */
export const requestSshRuntimeDrain = (input: {
  readonly port: number;
  readonly instanceId: string;
  readonly targetVersion: string;
  readonly graceSeconds: number;
  readonly force: boolean;
  readonly tokenFile: string;
  /** A client's automatic idle refresh, which the runtime may drop in favour of its own target. */
  readonly automatic?: boolean;
}): Promise<"drained" | "cancelled" | "instance-changed" | "unknown"> =>
  new Promise((resolve) => {
    let token: string;
    try {
      token = NodeFS.readFileSync(input.tokenFile, "utf8").trim();
    } catch {
      resolve("unknown");
      return;
    }
    if (token === "" || !instanceToken(input.instanceId)) {
      resolve("unknown");
      return;
    }
    const graceSeconds = Math.min(Math.max(0, input.graceSeconds), RUNTIME_DRAIN_MAX_GRACE_SECONDS);
    const body = JSON.stringify({
      expectedInstanceId: input.instanceId,
      targetVersion: input.targetVersion,
      graceSeconds,
      ...(input.force ? { force: true } : {}),
      ...(input.automatic === true ? { automatic: true } : {}),
    });
    let settled = false;
    const finish = (value: "drained" | "cancelled" | "instance-changed" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(value);
    };
    const request = NodeHttp.request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: GOAT_RUNTIME_DRAIN_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          [GOAT_RUNTIME_CONTROL_HEADER]: token,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) finish("unknown");
          else chunks.push(chunk);
        });
        response.once("error", () => finish("unknown"));
        response.once("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error("drain refused");
            const result = Schema.decodeUnknownSync(RuntimeDrainResult)(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            // A drain is only proven for the start the caller named.
            if (result.status !== "instance-changed" && result.instanceId !== input.instanceId)
              finish("unknown");
            else finish(result.status);
          } catch {
            finish("unknown");
          }
        });
      },
    );
    // The server answers when the window closes; allow it the full window plus slack.
    const deadline = setTimeout(() => finish("unknown"), (graceSeconds + 30) * 1000);
    request.once("error", () => finish("unknown"));
    request.end(body);
  });

const drain = Command.make("drain", {
  port: Flag.Int("port"),
  instanceId: Flag.String("instance-id"),
  targetVersion: Flag.String("target-version"),
  graceSeconds: Flag.Int("grace-seconds").pipe(
    Flag.withDefault(RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS),
  ),
  force: Flag.Boolean("force").pipe(Flag.withDefault(false)),
  tokenFile: Flag.String("token-file"),
}).pipe(
  Command.withHandler((input) =>
    Effect.flatMap(HostProcess.Environment, (environment) =>
      Effect.promise(async () => {
        // An environment marker, so launch scripts can pass it to helpers that predate it.
        const automatic = environment[RUNTIME_DRAIN_AUTOMATIC_ENV] === "1";
        process.stdout.write((await requestSshRuntimeDrain({ ...input, automatic })) + "\n");
      }),
    ),
  ),
);

export const RUNTIME_DRAIN_AUTOMATIC_ENV = "GOAT_RUNTIME_DRAIN_AUTOMATIC";

/**
 * The supervisor's record of the last replacement it ran, in the launch state directory it
 * already owns. The runtime reads it to skip a target that failed or rolled back.
 */
export const SSH_REPLACEMENT_RECORD_FILE = "last-replacement.json";
const SshReplacementRecord = Schema.Struct({
  status: Schema.Literals(["replaced", "rolled-back", "failed"]),
  targetVersion: Schema.String,
  previousVersion: Schema.String,
  at: Schema.String,
});
const SshReplacementRecordJson = Schema.fromJsonString(SshReplacementRecord);
const decodeSshReplacementRecord = Schema.decodeUnknownOption(SshReplacementRecordJson);
const encodeSshReplacementRecord = Schema.encodeSync(SshReplacementRecordJson);
export const readSshReplacementRecord = (text: string) =>
  Option.getOrUndefined(decodeSshReplacementRecord(text.trim()));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForExit = async (pid: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
};

const DATABASE_SUFFIXES = ["", "-wal", "-shm"] as const;

const copyDatabase = (fromDir: string, toDir: string) => {
  NodeFS.mkdirSync(toDir, { recursive: true, mode: 0o700 });
  for (const suffix of DATABASE_SUFFIXES) {
    const source = NodePath.join(fromDir, `statev2.sqlite${suffix}`);
    const target = NodePath.join(toDir, `statev2.sqlite${suffix}`);
    if (NodeFS.existsSync(source)) NodeFS.copyFileSync(source, target);
    else NodeFS.rmSync(target, { force: true });
  }
};

const writeAtomically = (file: string, contents: string, mode = 0o600) => {
  const next = `${file}.next.${process.pid}`;
  NodeFS.writeFileSync(next, contents, { mode });
  NodeFS.renameSync(next, file);
};

const writeLaunchRecords = (stateDir: string, identity: string, pid: number, port: number) => {
  for (const [name, contents] of [
    ["identity", `${identity}\n`],
    ["pid", `${pid}\n`],
    ["port", `${port}\n`],
    ["managed", "managed\n"],
  ] as const)
    writeAtomically(NodePath.join(stateDir, name), contents);
};

const restoreRunner = (input: SshRuntimeSupervisorInput) => {
  NodeFS.copyFileSync(input.previousRunnerFile, `${input.runnerFile}.restore`);
  NodeFS.chmodSync(`${input.runnerFile}.restore`, 0o700);
  NodeFS.renameSync(`${input.runnerFile}.restore`, input.runnerFile);
};

export interface SshRuntimeSupervisorInput {
  /** The drained server. The supervisor never signals it; it waits for it to exit. */
  readonly oldPid: number;
  readonly oldInstanceId: string;
  readonly port: number;
  readonly baseDir: string;
  readonly stateDir: string;
  /** Published runner for `targetVersion`, and a private copy of the one it replaced. */
  readonly runnerFile: string;
  readonly previousRunnerFile: string;
  readonly targetVersion: string;
  readonly previousVersion: string;
  /** Launch identities recorded for the ownership checks, as the launch script writes them. */
  readonly identity: string;
  readonly previousIdentity: string;
  /**
   * On a Windows host, the release executables behind `runnerFile` and `previousRunnerFile`:
   * the runners are shell scripts there, and Windows starts the executable itself.
   */
  readonly executable?: string | undefined;
  readonly previousExecutable?: string | undefined;
  /** The host's platform; Windows starts replacements outside the SSH session's job. */
  readonly platform?: NodeJS.Platform | undefined;
  readonly exitTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly logFile: string;
}

export type SshRuntimeSupervisorResult =
  | { readonly status: "replaced" | "rolled-back"; readonly pid: number; readonly version: string }
  | { readonly status: "old-alive" | "failed"; readonly reason: string };

/**
 * Starts a program outside the SSH session's job object, which Windows OpenSSH terminates with
 * the session, and returns its PID. See {@link WINDOWS_DETACHED_SPAWN_POWERSHELL}.
 */
const spawnWindowsDetached = (
  argv: ReadonlyArray<string>,
  logFile: string,
  env: Readonly<Record<string, string>>,
) => {
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellCommand(WINDOWS_DETACHED_SPAWN_POWERSHELL),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GOAT_SPAWN_ARGS: argv.join("\n"),
        GOAT_SPAWN_LOG: logFile,
        GOAT_SPAWN_ENV: Object.entries(env)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n"),
      },
    },
  );
  const pid = Number.parseInt(result.stdout?.trim() ?? "", 10);
  return result.status === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Swaps the drained server for `targetVersion` on the same port. It runs detached from the SSH
 * session, so a dropped client cannot leave the host without a server. The new server must pass
 * the handshake: its descriptor names `targetVersion`, a new instance, and protocol ranges this
 * build attaches to. Otherwise the supervisor stops only the child it started, restores the
 * database and runner it backed up, and starts the previous version again.
 *
 * The backup and the restore both run under server-owner.lock. The restore is skipped when any
 * server other than this supervisor and the replacement it started owned the data since the
 * backup, so another server's writes are never overwritten by the snapshot.
 */
export const superviseSshRuntimeReplacement = async (
  input: SshRuntimeSupervisorInput,
): Promise<SshRuntimeSupervisorResult> => {
  let result: SshRuntimeSupervisorResult;
  try {
    result = await superviseReplacement(input);
  } catch (cause) {
    result = {
      status: "failed",
      reason: cause instanceof Error ? cause.message : "Replacement supervisor failed.",
    };
  }
  if (result.status !== "old-alive") {
    try {
      writeAtomically(
        NodePath.join(input.stateDir, SSH_REPLACEMENT_RECORD_FILE),
        encodeSshReplacementRecord({
          status: result.status,
          targetVersion: input.targetVersion,
          previousVersion: input.previousVersion,
          at: new Date().toISOString(),
        }) + "\n",
      );
    } catch (cause) {
      // The replacement result stands; without the record the runtime may retry this target.
      process.stderr.write(
        `Could not record the replacement outcome: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
  }
  return result;
};

const superviseReplacement = async (
  input: SshRuntimeSupervisorInput,
): Promise<SshRuntimeSupervisorResult> => {
  if (!(await waitForExit(input.oldPid, input.exitTimeoutMs))) {
    // The drained server still owns the data, so it stays the recorded runtime and is never
    // signalled. The draining marker keeps launches from starting a second server beside it.
    restoreRunner(input);
    NodeFS.rmSync(input.previousRunnerFile, { force: true });
    writeLaunchRecords(input.stateDir, input.previousIdentity, input.oldPid, input.port);
    return {
      status: "old-alive",
      reason: `The drained GOAT ${input.previousVersion} (pid ${input.oldPid}) did not exit; it was left running.`,
    };
  }
  const userdata = NodePath.join(input.baseDir, "userdata");
  const backup = NodePath.join(input.stateDir, "replacement-backup");
  const replacementId = NodeCrypto.randomUUID();
  const ours = new Set([sshSupervisorOwner(replacementId), sshReplacementOwner(replacementId)]);
  NodeFS.mkdirSync(userdata, { recursive: true, mode: 0o700 });
  const backupLock = tryAcquireServerOwnerLock(userdata, sshSupervisorOwner(replacementId));
  if (backupLock === undefined)
    return {
      status: "failed",
      reason: `Another GOAT server is using ${userdata}; GOAT ${input.targetVersion} was not started.`,
    };
  const backupGeneration = backupLock.generation;
  try {
    copyDatabase(userdata, backup);
  } finally {
    backupLock.release();
  }

  const start = async (
    runner: string,
    executable: string | undefined,
    version: string,
    identity: string,
    accepts: (verdict: RuntimeProtocolVerdict) => boolean,
    extraEnv: Record<string, string> = {},
  ) => {
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--base-dir",
      input.baseDir,
    ];
    const env = { GOAT_NO_BROWSER: "1", ...extraEnv };
    let pid: number | undefined;
    if (input.platform === "win32") {
      pid =
        executable === undefined
          ? undefined
          : spawnWindowsDetached([executable, ...args], input.logFile, env);
    } else {
      const log = NodeFS.openSync(input.logFile, "a");
      const child = NodeChildProcess.spawn(runner, args, {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, ...env },
      });
      NodeFS.closeSync(log);
      child.unref();
      pid = child.pid;
    }
    if (pid === undefined) return undefined;
    const deadline = Date.now() + input.readyTimeoutMs;
    while (Date.now() < deadline && processExists(pid)) {
      try {
        const value = await readSshRuntimeCompatibility(input.port);
        if (
          value.serverVersion === version &&
          accepts(value.verdict) &&
          value.instanceId !== undefined &&
          value.instanceId !== input.oldInstanceId
        ) {
          writeLaunchRecords(input.stateDir, identity, pid, input.port);
          return pid;
        }
      } catch {
        // Not answering yet.
      }
      await delay(100);
    }
    // Only the child this supervisor started is ever signalled.
    if (processExists(pid)) {
      process.kill(pid, "SIGTERM");
      if (!(await waitForExit(pid, 5000))) process.kill(pid, "SIGKILL");
      await waitForExit(pid, 5000);
    }
    return undefined;
  };

  const started = await start(
    input.runnerFile,
    input.executable,
    input.targetVersion,
    input.identity,
    (verdict) => verdict === "compatible",
    { [SSH_REPLACEMENT_ID_ENV]: replacementId },
  );
  if (started !== undefined) {
    NodeFS.rmSync(backup, { recursive: true, force: true });
    NodeFS.rmSync(input.previousRunnerFile, { force: true });
    return { status: "replaced", pid: started, version: input.targetVersion };
  }
  const restoreLock = tryAcquireServerOwnerLock(userdata, sshSupervisorOwner(replacementId));
  if (restoreLock === undefined)
    return {
      status: "failed",
      reason: `GOAT ${input.targetVersion} did not start and another GOAT server is now using ${userdata}; its database was left as is.`,
    };
  try {
    if (restoreLock.ownersSince(backupGeneration).every((owner) => ours.has(owner)))
      copyDatabase(backup, userdata);
  } finally {
    restoreLock.release();
  }
  restoreRunner(input);
  // The previous version served this host before the swap. After an incompatible replacement
  // it does not speak this build's protocol, so it must only prove it is that version, freshly
  // started, advertising protocol ranges of its own.
  const restored = await start(
    input.runnerFile,
    input.previousExecutable,
    input.previousVersion,
    input.previousIdentity,
    (verdict) => verdict !== "unknown",
  );
  if (restored === undefined)
    return {
      status: "failed",
      reason: `GOAT ${input.targetVersion} and the previous ${input.previousVersion} both failed to start.`,
    };
  NodeFS.rmSync(backup, { recursive: true, force: true });
  NodeFS.rmSync(input.previousRunnerFile, { force: true });
  return { status: "rolled-back", pid: restored, version: input.previousVersion };
};

const supervise = Command.make("supervise", {
  oldPid: Flag.Int("old-pid"),
  oldInstanceId: Flag.String("old-instance-id"),
  port: Flag.Int("port"),
  baseDir: Flag.String("base-dir"),
  stateDir: Flag.String("state-dir"),
  runnerFile: Flag.String("runner"),
  previousRunnerFile: Flag.String("previous-runner"),
  targetVersion: Flag.String("target-version"),
  previousVersion: Flag.String("previous-version"),
  identity: Flag.String("identity"),
  previousIdentity: Flag.String("previous-identity"),
  executable: Flag.String("executable").pipe(Flag.optional),
  previousExecutable: Flag.String("previous-executable").pipe(Flag.optional),
  exitTimeoutMs: Flag.Int("exit-timeout-ms").pipe(Flag.withDefault(60_000)),
  readyTimeoutMs: Flag.Int("ready-timeout-ms").pipe(Flag.withDefault(60_000)),
  logFile: Flag.String("log"),
  resultFile: Flag.String("result"),
}).pipe(
  Command.withHandler(({ resultFile, executable, previousExecutable, ...input }) =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(async () => {
        let result: SshRuntimeSupervisorResult;
        try {
          result = await superviseSshRuntimeReplacement({
            ...input,
            executable: Option.getOrUndefined(executable),
            previousExecutable: Option.getOrUndefined(previousExecutable),
            platform,
          });
        } catch (cause) {
          result = {
            status: "failed",
            reason: cause instanceof Error ? cause.message : "Replacement supervisor failed.",
          };
        }
        const line = `${result.status} ${"pid" in result ? result.pid : 0} ${"version" in result ? result.version : "-"}\n`;
        writeAtomically(resultFile, line);
        if ("reason" in result) process.stderr.write(result.reason + "\n");
        process.stdout.write(line);
      }),
    ),
  ),
);

/** GOAT runtime subcommands of `__ssh-helper`: protocol checks, drain and replacement. */
export const sshRuntimeHelperCommands = [
  protocol,
  runtimeManifest,
  activity,
  compareVersion,
  commitTime,
  compat,
  drain,
  supervise,
] as const;
