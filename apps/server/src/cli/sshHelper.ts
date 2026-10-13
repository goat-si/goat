import { LEGACY_ENVIRONMENT_PATH, LEGACY_ACTIVITY_PATH } from "@goat/contracts/legacyT3Names";
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
// The helpers mirror the inline Node snippets the SSH launch script used to
// run, byte for byte in behaviour, so they stay on plain Node APIs.
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
import { compareSemverVersions } from "@goat/shared/semver";
import {
  compareRuntimeProtocols,
  ownRuntimeProtocolRanges,
  SSH_RUNTIME_PROTOCOL_VERSION,
} from "@goat/shared/sshRuntimeProtocol";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import packageJson from "../../package.json" with { type: "json" };

/**
 * Small helpers the SSH launch script needs on the remote host. The script
 * used to run these as inline `node -` snippets; archive-distributed runtimes
 * have no Node on the remote, so the executable provides them instead. Output
 * and exit codes match the snippets exactly because the shell script parses
 * them.
 */

const tryPort = (port: number) =>
  new Promise<number | false>((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });

/** Prints the first free loopback port from the preferred one, scanning `window` ports. */
const pickPort = Command.make("pick-port", {
  portFile: Argument.String("port-file"),
  defaultPort: Argument.Int("default-port"),
  scanWindow: Argument.Int("scan-window"),
}).pipe(
  Command.withHandler(({ portFile, defaultPort, scanWindow }) =>
    Effect.promise(async () => {
      const raw = NodeFS.existsSync(portFile) ? NodeFS.readFileSync(portFile, "utf8").trim() : "";
      const preferred = Number.parseInt(raw, 10);
      const start = Number.isInteger(preferred) ? preferred : defaultPort;
      for (let port = start; port < start + scanWindow; port += 1) {
        if (await tryPort(port)) {
          process.stdout.write(String(port));
          return;
        }
      }
      process.exitCode = 1;
    }),
  ),
);

const probe = (port: number, probeTimeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: probeTimeoutMs },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          resolve(status >= 200 && status < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });

/** Exits 0 once the loopback server answers, 1 when the deadline passes first. */
const waitReady = Command.make("wait-ready", {
  port: Argument.Int("port"),
  timeoutMs: Argument.Int("timeout-ms"),
  probeTimeoutMs: Argument.Int("probe-timeout-ms"),
}).pipe(
  Command.withHandler(({ port, timeoutMs, probeTimeoutMs }) =>
    Effect.promise(async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await probe(port, probeTimeoutMs)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      process.exitCode = 1;
    }),
  ),
);

/** Prints `<pid> <port>` for a live default-home server, or exits 1. */
const runtimePort = Command.make("runtime-port", {
  runtimeFile: Argument.String("runtime-file"),
}).pipe(
  Command.withHandler(({ runtimeFile }) =>
    Effect.sync(() => {
      try {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - mirrors the shell snippet's loose parse.
        const runtime = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as {
          pid?: unknown;
          port?: unknown;
          origin?: unknown;
        };
        const pid = Number(runtime.pid);
        const port = Number(runtime.port);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
          process.exitCode = 1;
          return;
        }
        const origin = new URL(String(runtime.origin ?? ""));
        if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
          process.exitCode = 1;
          return;
        }
        process.kill(pid, 0);
        process.stdout.write(`${pid} ${port}`);
      } catch {
        process.exitCode = 1;
      }
    }),
  ),
);

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
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: LEGACY_ENVIRONMENT_PATH, timeout: 1000 },
      (response) => {
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
      },
    );
    const deadline = setTimeout(() => {
      const cause = new Error("SSH descriptor deadline exceeded");
      request.destroy(cause);
      finish(cause);
    }, 1500);
    request.once("timeout", () => {
      const cause = new Error("SSH descriptor timed out");
      request.destroy(cause);
      finish(cause);
    });
    request.once("error", finish);
  });

const protocolVersion = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
const protocolInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
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
      request.destroy();
      resolve(value);
    };
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: LEGACY_ACTIVITY_PATH },
      (response) => {
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
      },
    );
    const deadline = setTimeout(() => finish("unknown"), 1500);
    request.once("error", () => finish("unknown"));
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

/** Compare validated SemVer tokens for the pinned SSH replacement candidate. */
const compareVersion = Command.make("compare-version", {
  live: Argument.String("live-version"),
  requested: Argument.String("requested-version"),
}).pipe(
  Command.withHandler(({ live, requested }) =>
    Effect.sync(() => {
      if (!protocolVersion(live) || !protocolVersion(requested)) {
        process.stderr.write("Invalid SSH version comparison tokens.\n");
        process.exitCode = 1;
        return;
      }
      const comparison = compareSemverVersions(live, requested);
      process.stdout.write((comparison < 0 ? "older" : comparison > 0 ? "newer" : "equal") + "\n");
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
    Effect.promise(async () => {
      process.stdout.write((await requestSshRuntimeDrain(input)) + "\n");
    }),
  ),
);

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
  readonly exitTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly logFile: string;
}

export type SshRuntimeSupervisorResult =
  | { readonly status: "replaced" | "rolled-back"; readonly pid: number; readonly version: string }
  | { readonly status: "old-alive" | "failed"; readonly reason: string };

/**
 * Swaps the drained server for `targetVersion` on the same port. It runs detached from the SSH
 * session, so a dropped client cannot leave the host without a server. The new server must pass
 * the handshake: its descriptor names `targetVersion`, a new instance, and protocol ranges this
 * build attaches to. Otherwise the supervisor stops only the child it started, restores the
 * database and runner it backed up, and starts the previous version again.
 */
export const superviseSshRuntimeReplacement = async (
  input: SshRuntimeSupervisorInput,
): Promise<SshRuntimeSupervisorResult> => {
  if (!(await waitForExit(input.oldPid, input.exitTimeoutMs)))
    return { status: "old-alive", reason: "The drained server did not exit; it was left running." };
  const userdata = NodePath.join(input.baseDir, "userdata");
  const backup = NodePath.join(input.stateDir, "replacement-backup");
  copyDatabase(userdata, backup);

  const start = async (runner: string, version: string, identity: string) => {
    const log = NodeFS.openSync(input.logFile, "a");
    const child = NodeChildProcess.spawn(
      runner,
      ["serve", "--host", "127.0.0.1", "--port", String(input.port), "--base-dir", input.baseDir],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, T3CODE_NO_BROWSER: "1" },
      },
    );
    NodeFS.closeSync(log);
    child.unref();
    const pid = child.pid;
    if (pid === undefined) return undefined;
    const deadline = Date.now() + input.readyTimeoutMs;
    while (Date.now() < deadline && processExists(pid)) {
      try {
        const value = await readSshRuntimeCompatibility(input.port);
        if (
          value.serverVersion === version &&
          value.verdict === "compatible" &&
          value.instanceId !== undefined &&
          value.instanceId !== input.oldInstanceId
        ) {
          for (const [name, contents] of [
            ["identity", `${identity}\n`],
            ["pid", `${pid}\n`],
            ["port", `${input.port}\n`],
            ["managed", "managed\n"],
          ] as const)
            writeAtomically(NodePath.join(input.stateDir, name), contents);
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

  const started = await start(input.runnerFile, input.targetVersion, input.identity);
  if (started !== undefined) {
    NodeFS.rmSync(backup, { recursive: true, force: true });
    NodeFS.rmSync(input.previousRunnerFile, { force: true });
    return { status: "replaced", pid: started, version: input.targetVersion };
  }
  copyDatabase(backup, userdata);
  NodeFS.copyFileSync(input.previousRunnerFile, `${input.runnerFile}.restore`);
  NodeFS.chmodSync(`${input.runnerFile}.restore`, 0o700);
  NodeFS.renameSync(`${input.runnerFile}.restore`, input.runnerFile);
  const restored = await start(input.runnerFile, input.previousVersion, input.previousIdentity);
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
  exitTimeoutMs: Flag.Int("exit-timeout-ms").pipe(Flag.withDefault(60_000)),
  readyTimeoutMs: Flag.Int("ready-timeout-ms").pipe(Flag.withDefault(60_000)),
  logFile: Flag.String("log"),
  resultFile: Flag.String("result"),
}).pipe(
  Command.withHandler(({ resultFile, ...input }) =>
    Effect.promise(async () => {
      let result: SshRuntimeSupervisorResult;
      try {
        result = await superviseSshRuntimeReplacement(input);
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
);

export const sshHelperCommand = Command.make("__ssh-helper").pipe(
  Command.unlisted,
  Command.withSubcommands([
    pickPort,
    waitReady,
    runtimePort,
    protocol,
    activity,
    compareVersion,
    compat,
    drain,
    supervise,
  ]),
);
