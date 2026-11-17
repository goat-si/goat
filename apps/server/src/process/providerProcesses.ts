// @effect-diagnostics nodeBuiltinImport:off -- the SDK's synchronous spawn callback must record ownership before releasing the child.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { signalProcessGroup } from "@goat/provider-core/server/processGroup";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const ProcessIdentity = Schema.Struct({
  pid: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER })),
  startTime: Schema.String,
});
const OwnershipRecord = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: Schema.String,
  hostname: Schema.String,
  stateDir: Schema.String,
  owner: ProcessIdentity,
  processes: Schema.Array(Schema.Struct({ ...ProcessIdentity.fields, pgid: Schema.Int })),
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(OwnershipRecord));

// A concurrent exit can remove the record. Incomplete/unknown records never authorize a signal.
const readRecord = (recordPath: string) => {
  try {
    return decodeRecord(NodeFS.readFileSync(recordPath, "utf8"));
  } catch {
    return undefined;
  }
};

export interface ProviderProcessesShape {
  /** Records a spawned provider before it may run; returns the call that forgets it. */
  readonly register?: (pid: number) => () => void;
  readonly hasOtherLiveOwner: boolean;
}

export const ProviderProcesses = Context.Reference<ProviderProcessesShape>(
  "goat/process/ProviderProcesses",
  { defaultValue: () => ({ hasOtherLiveOwner: false }) },
);

const LINUX_BOOT_ID = "/proc/sys/kernel/random/boot_id";

/**
 * Linux only. Records this server and each Claude CLI it starts under the state directory, and at
 * startup kills the recorded CLIs of a dead server that are still the same process. Reaping is
 * skipped, never fatal, when the host cannot identify processes.
 */
export const make = Effect.fn("ProviderProcesses.make")(function* (
  options: {
    readonly bootIdPath?: string;
    readonly controller?: AcpSessionRuntime.AcpPosixProcessTreeController;
  } = {},
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return ProviderProcesses.defaultValue();
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = NodePath.join(stateDir, "provider-processes");
  const hostname = NodeOS.hostname();
  const controller =
    options.controller ?? AcpSessionRuntime.makePosixProcessTreeController(platform);
  const boot = yield* Effect.try(() => {
    const id = NodeFS.readFileSync(options.bootIdPath ?? LINUX_BOOT_ID, "utf8").trim();
    NodeFS.mkdirSync(directory, { recursive: true });
    return id;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Provider survivors of a previous server will not be reaped", {
        cause: String(cause),
      }).pipe(Effect.as(undefined)),
    ),
  );
  if (boot === undefined) return ProviderProcesses.defaultValue();
  const identity = (pid: number) => {
    const observed = controller.identity(pid);
    if (observed === undefined || AcpSessionRuntime.posixProcessIsZombie(observed))
      return undefined;
    return { ...observed, startTime: `${boot}:${observed.startTime}` };
  };
  const matches = (expected: typeof ProcessIdentity.Type) =>
    identity(expected.pid)?.startTime === expected.startTime;
  const owner = identity(process.pid);
  if (owner === undefined) {
    yield* Effect.logWarning("Provider survivors of a previous server will not be reaped", {
      cause: "this server's process identity is unreadable",
    });
    return ProviderProcesses.defaultValue();
  }
  // A recorded pid now held by this server or one of its ancestors is never signalled.
  const protectedPids = new Set<number>();
  for (let pid = process.pid; pid > 1 && !protectedPids.has(pid);) {
    protectedPids.add(pid);
    pid = controller.identity(pid)?.ppid ?? 0;
  }

  const writeRecord = (processes: (typeof OwnershipRecord.Type)["processes"]) => {
    const instanceId = NodeCrypto.randomUUID();
    const recordPath = NodePath.join(directory, `${instanceId}.json`);
    const pendingPath = `${recordPath}.pending`;
    NodeFS.writeFileSync(
      pendingPath,
      JSON.stringify({
        version: 1,
        instanceId,
        hostname,
        stateDir,
        owner: { pid: owner.pid, startTime: owner.startTime },
        processes,
      } satisfies typeof OwnershipRecord.Type),
    );
    NodeFS.renameSync(pendingPath, recordPath);
    return () => NodeFS.rmSync(recordPath, { force: true });
  };
  // Publish the server identity even before its first provider. Another server
  // using this home must not stop the shared systemd slice while we are alive.
  const forgetOwner = yield* Effect.try(() => writeRecord([])).pipe(Effect.option);
  if (forgetOwner._tag === "None") return ProviderProcesses.defaultValue();
  // Startup must survive a state directory that turns unreadable or read-only under it.
  const tryQuietly = (operation: () => void) => Effect.try(operation).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => tryQuietly(forgetOwner.value));
  let hasOtherLiveOwner = false;

  // Only immutable per-launch records are shared between server instances. A
  // live owner's records belong to that server, even when it uses this home.
  const files = yield* Effect.try(() => NodeFS.readdirSync(directory)).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const reaped: Array<{
    readonly file: string;
    readonly recordPath: string;
    readonly survivors: ReadonlyArray<typeof ProcessIdentity.Type>;
  }> = [];
  for (const file of files) {
    const pending = file.endsWith(".json.pending");
    if (!file.endsWith(".json") && !pending) continue;
    const recordPath = NodePath.join(directory, file);
    const record = readRecord(recordPath);
    if (record === undefined) continue;
    if (record.hostname !== hostname || record.stateDir !== stateDir) continue;
    if (matches(record.owner)) {
      if (record.owner.pid !== process.pid) hasOtherLiveOwner = true;
      continue;
    }
    // A CLI whose record was never renamed was still gated and exited when its server died.
    if (pending) {
      yield* tryQuietly(() => NodeFS.rmSync(recordPath, { force: true }));
      continue;
    }
    const survivors = record.processes.filter(
      (survivor) => !protectedPids.has(survivor.pid) && matches(survivor),
    );
    for (const survivor of survivors) {
      // Never infer ownership from argv or executable names. Start time blocks pid reuse and is
      // read again right before the signal (Node has no pidfd_send_signal, so that race remains).
      // A CLI still leading the group it was recorded with takes its MCP servers with it.
      yield* tryQuietly(() => {
        if (!matches(survivor)) return;
        if (survivor.pgid === survivor.pid && survivor.pgid > 1 && survivor.pgid !== owner.pgid)
          signalProcessGroup(survivor.pgid, "SIGKILL");
        else controller.signalProcess(survivor.pid, "SIGKILL");
      });
    }
    reaped.push({ file, recordPath, survivors });
  }
  // Every survivor was signalled first, so unkillable CLIs cost startup about a second in all.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!reaped.some(({ survivors }) => survivors.some(matches))) break;
    yield* Effect.sleep("10 millis");
  }
  for (const { file, recordPath, survivors } of reaped) {
    // Like a failed slice stop, an unkillable CLI must not keep the server down;
    // its record stays so the next start retries.
    if (survivors.some(matches)) {
      yield* Effect.logWarning("Could not stop a provider left by a previous server", { file });
      continue;
    }
    yield* tryQuietly(() => NodeFS.rmSync(recordPath, { force: true }));
  }

  return {
    hasOtherLiveOwner,
    register: (pid: number) => {
      const provider = identity(pid);
      if (provider === undefined || provider.ppid !== process.pid) {
        throw new Error("Cannot identify spawned provider");
      }
      // A rename keeps startup from seeing a partial write. The child is gated
      // until this returns, so an abrupt death cannot leave an unrecorded CLI.
      return writeRecord([{ pid, startTime: provider.startTime, pgid: provider.pgid }]);
    },
  } satisfies ProviderProcessesShape;
});

export const layer = Layer.effect(ProviderProcesses, make());
