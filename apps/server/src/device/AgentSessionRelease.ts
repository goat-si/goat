import {
  type DeviceHostId,
  type DeviceId,
  DeviceOperationError,
  type DeviceSession,
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveNodeExecutable } from "@goat/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import { agentDeviceConfigPath, agentDeviceSession } from "./AgentDeviceTarget.ts";
import {
  agentDeviceStateDir,
  ensureAgentDevice,
  isAgentDeviceInstalled,
} from "./DeviceToolchain.ts";

const decodeDaemonPid = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number })),
);

/** One agent-device session GOAT named for a thread's device (AgentDeviceTarget.agentDeviceSession). */
export interface AgentSessionTarget {
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
}

/**
 * "absent": agent-device holds no such session any more. "pending": GOAT cannot run the close yet
 * (agent-device or its host config is missing), so the session stays queued without failing.
 */
export type AgentSessionClose = (
  target: AgentSessionTarget,
) => Effect.Effect<"closed" | "absent" | "pending", DeviceOperationError>;

const targetKey = (target: AgentSessionTarget) =>
  JSON.stringify([target.threadId, target.hostId, target.deviceId]);

/**
 * Ending a GOAT device session does not end the agent-device session behind it, and agent-device
 * keeps that session's XCTest runner until it is closed. Every session GOAT drops, for whatever
 * reason, waits here until its close succeeds or agent-device confirms it is gone.
 */
export const makePendingAgentCloses = (close: AgentSessionClose) => {
  const pending = new Map<string, AgentSessionTarget>();
  // Sessions reuse one agent-device name per thread and device, so a close must not overlap a reopen.
  const admissions = new Map<string, Semaphore.Semaphore>();
  const admit = (target: AgentSessionTarget) => {
    const key = targetKey(target);
    const admission = admissions.get(key) ?? Semaphore.makeUnsafe(1);
    admissions.set(key, admission);
    return admission;
  };
  const settle = (target: AgentSessionTarget, open: Effect.Effect<ReadonlyArray<DeviceSession>>) =>
    admit(target).withPermit(
      Effect.gen(function* () {
        const key = targetKey(target);
        // A reopened session owns the name again; closing it would end the live session.
        if ((yield* open).some((session) => targetKey(session) === key)) return pending.delete(key);
        if ((yield* close(target)) !== "pending") pending.delete(key);
      }),
    );
  return {
    exclusive: <A, E, R>(target: AgentSessionTarget, effect: Effect.Effect<A, E, R>) =>
      admit(target).withPermit(effect),
    track: (previous: ReadonlyArray<DeviceSession>, next: ReadonlyArray<DeviceSession>) => {
      if (previous === next) return;
      const kept = new Set(next.map(targetKey));
      for (const session of previous) {
        if (!kept.has(targetKey(session)))
          pending.set(targetKey(session), {
            threadId: session.threadId,
            hostId: session.hostId,
            deviceId: session.deviceId,
          });
      }
    },
    /** Closes this thread's pending sessions; a failure stays pending for its next close or release. */
    flush: Effect.fn("AgentSessionRelease.flush")(function* (
      threadId: ThreadId,
      open: Effect.Effect<ReadonlyArray<DeviceSession>>,
    ) {
      const targets = [...pending.values()].filter((target) => target.threadId === threadId);
      const results = yield* Effect.forEach(
        targets,
        (target) => settle(target, open).pipe(Effect.result),
        { concurrency: 4 },
      );
      const failure = results.find((result) => result._tag === "Failure");
      if (failure?._tag === "Failure") return yield* failure.failure;
    }),
  };
};

/** Reads `agent-device close --json`; an unreachable daemon is not yet proof the session is gone. */
export function classifyAgentClose(result: {
  readonly code: number | null;
  readonly stdout: string;
}): "closed" | "absent" | "unreachable" | "failed" {
  let parsed: { success?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return "failed";
  }
  if (parsed === null || typeof parsed !== "object") return "failed";
  if (parsed.success === true && result.code === 0) return "closed";
  if (parsed.error?.code === "SESSION_NOT_FOUND") return "absent";
  const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
  return /daemon is unavailable/iu.test(message) ? "unreachable" : "failed";
}

export const makeAgentSessionClose = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const exists = (file: string) => fs.exists(file).pipe(Effect.mapError(failed));
  const failed = (cause: unknown) =>
    new DeviceOperationError({ operation: "close agent session", reason: "command_failed", cause });
  const close: AgentSessionClose = Effect.fn("AgentSessionRelease.close")(
    function* (target: AgentSessionTarget) {
      if (!(yield* isAgentDeviceInstalled(config.baseDir).pipe(Effect.mapError(failed))))
        return "pending" as const;
      // Hosts with a daemon per device keep a config per device; agents only reach a daemon through one.
      const perDevice = yield* agentDeviceConfigPath(
        config.stateDir,
        target.hostId,
        path,
        target.deviceId,
      );
      const shared = yield* agentDeviceConfigPath(config.stateDir, target.hostId, path);
      const configFile = (yield* exists(perDevice))
        ? perDevice
        : (yield* exists(shared))
          ? shared
          : null;
      if (configFile === null) return "pending" as const;
      const tool = yield* ensureAgentDevice(config.baseDir).pipe(Effect.mapError(failed));
      const nodePath = yield* resolveNodeExecutable("Device automation", environment).pipe(
        Effect.mapError(failed),
      );
      const session = yield* agentDeviceSession(target.threadId, target.hostId, target.deviceId);
      const result = yield* runner
        .run({
          command: nodePath,
          args: [tool.entryPath, "close", "--config", configFile, "--session", session, "--json"],
          env: { ...environment, AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" },
          timeout: Duration.seconds(10),
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.mapError(failed));
      const outcome = classifyAgentClose(result);
      if (outcome === "closed" || outcome === "absent") return outcome;
      // A local daemon that no longer runs took its sessions and runners with it.
      if (outcome === "unreachable" && target.hostId === LOCAL_DEVICE_HOST_ID) {
        const daemonFile = path.join(agentDeviceStateDir(path, config.stateDir), "daemon.json");
        // Only a recorded daemon process that has exited proves it; a missing record proves nothing.
        const recorded = yield* fs.readFileString(daemonFile).pipe(Effect.option);
        const daemon = Option.flatMap(recorded, decodeDaemonPid);
        if (Option.isSome(daemon) && !isProcessAlive(daemon.value.pid)) return "absent" as const;
      }
      return yield* failed(
        new Error(`agent-device close exited ${result.code}: ${result.stdout.slice(0, 400)}`),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(Crypto.Crypto, crypto),
  );
  return close;
});
