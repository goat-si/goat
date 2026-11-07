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
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { agentDeviceConfigPath, agentDeviceSession } from "./AgentDeviceTarget.ts";
import { ensureAgentDevice, isAgentDeviceInstalled } from "./DeviceToolchain.ts";

/** One agent-device session GOAT named for a thread's device (AgentDeviceTarget.agentDeviceSession). */
export interface AgentSessionTarget {
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
}

/** "absent" means agent-device holds no such session any more, so nothing is left to close. */
export type AgentSessionClose = (
  target: AgentSessionTarget,
) => Effect.Effect<"closed" | "absent", DeviceOperationError>;

const targetKey = (target: AgentSessionTarget) =>
  JSON.stringify([target.threadId, target.hostId, target.deviceId]);

/**
 * Ending a GOAT device session does not end the agent-device session behind it, and agent-device
 * keeps that session's XCTest runner until it is closed. Every session GOAT drops, for whatever
 * reason, waits here until its close succeeds or agent-device confirms it is gone.
 */
export const makePendingAgentCloses = (close: AgentSessionClose) => {
  const pending = new Map<string, AgentSessionTarget>();
  return {
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
    flush: Effect.fn("AgentSessionRelease.flush")(function* (threadId: ThreadId) {
      const targets = [...pending.values()].filter((target) => target.threadId === threadId);
      const results = yield* Effect.forEach(
        targets,
        (target) =>
          close(target).pipe(
            Effect.tap(() => Effect.sync(() => pending.delete(targetKey(target)))),
            Effect.result,
          ),
        { concurrency: 4 },
      );
      const failure = results.find((result) => result._tag === "Failure");
      if (failure !== undefined) return yield* failure.failure;
    }),
  };
};

/** Reads `agent-device close --json`. Only a confirmed missing session or local daemon retires it. */
export function classifyAgentClose(
  result: { readonly code: number | null; readonly stdout: string },
  options: { readonly local: boolean },
): "closed" | "absent" | "failed" {
  let parsed: { success?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return "failed";
  }
  if (parsed === null || typeof parsed !== "object") return "failed";
  if (parsed.success === true && result.code === 0) return "closed";
  if (parsed.error?.code === "SESSION_NOT_FOUND") return "absent";
  // A restarted local daemon starts without its predecessor's sessions; a remote one may just be unreachable.
  const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
  return options.local && /daemon is unavailable/iu.test(message) ? "absent" : "failed";
}

export const makeAgentSessionClose = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const failed = (cause: unknown) =>
    new DeviceOperationError({ operation: "close agent session", reason: "command_failed", cause });
  const close: AgentSessionClose = Effect.fn("AgentSessionRelease.close")(
    function* (target: AgentSessionTarget) {
      if (!(yield* isAgentDeviceInstalled(config.baseDir).pipe(Effect.orElseSucceed(() => false))))
        return "absent" as const;
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
      if (configFile === null) return "absent" as const;
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
      const outcome = classifyAgentClose(result, { local: target.hostId === LOCAL_DEVICE_HOST_ID });
      if (outcome === "failed")
        return yield* failed(
          new Error(`agent-device close exited ${result.code}: ${result.stdout.slice(0, 400)}`),
        );
      return outcome;
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(Crypto.Crypto, crypto),
  );
  return close;
});
