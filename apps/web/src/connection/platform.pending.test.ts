import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
  type DesktopSshRuntimePendingResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import {
  prepareDesktopSshEnvironment,
  provisionDesktopSshEnvironment,
  readDesktopSshRuntime,
} from "./platform.ts";

const target = { alias: "box", hostname: "box.test", username: null, port: null };
const messages = {
  busy: "Remote runtime will be replaced when its work finishes.",
  unknown:
    "Remote runtime will be replaced when its work finishes. Waiting for a verified idle response.",
  contended: "Another client is replacing the remote runtime.",
};
describe.each([
  {
    label: "existing SSH connection",
    consumer: (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) =>
      prepareDesktopSshEnvironment(bridge, {
        target,
        expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
      }),
  },
  { label: "new SSH connection", consumer: provisionDesktopSshEnvironment },
])("$label", ({ consumer }) => {
  it.effect("connects to a busy runtime whose replacement is scheduled", () =>
    Effect.gen(function* () {
      const bridge = {
        getSshHostStatus: async () => ({
          kind: "ok",
          status: {
            host: "box",
            state: "update_waiting",
            runtimeVersion: "1.2.2",
            requestedVersion: "1.2.3",
            detail: "busy",
          },
        }),
        ensureSshEnvironment: async () => ({
          target,
          httpBaseUrl: "http://127.0.0.1:3201/",
          wsBaseUrl: "ws://127.0.0.1:3201/",
          pairingToken: "pairing-token",
          remoteServerVersion: "1.2.2",
          pendingReplacement: {
            reason: "busy",
            replacement: "older",
            requestedVersion: "1.2.3",
            liveVersion: "1.2.2",
          },
        }),
        fetchSshEnvironmentDescriptor: async () => ({
          environmentId: "environment-ssh",
          label: "SSH environment",
        }),
        bootstrapSshBearerSession: async () => ({ access_token: "bearer" }),
      } as unknown as DesktopBridge;
      const connected = yield* consumer(bridge, target);
      expect(connected.bearerToken).toBe("bearer");
      expect(connected.bootstrap.pendingReplacement?.requestedVersion).toBe("1.2.3");
      const ownerStatus = yield* readDesktopSshRuntime(bridge, target);
      expect(ownerStatus).toMatchObject({
        kind: "ok",
        status: { state: "update_waiting", requestedVersion: "1.2.3" },
      });
    }),
  );
  it.effect("explains a tunnel that answers too slowly as high latency", () =>
    Effect.gen(function* () {
      const bridge = {
        ensureSshEnvironment: async () => {
          throw new Error(
            "Error invoking remote method 'desktop:ensure-ssh-environment': Timed out waiting 30000ms for backend readiness at http://127.0.0.1:41773/. The SSH tunnel is open, but the GOAT server answered none of 9 checks within 5000ms. The network to this host is too slow (high latency); GOAT will keep retrying.",
          );
        },
      } as unknown as DesktopBridge;
      const error = yield* consumer(bridge, target).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "network" });
      expect(error.detail).toContain("high latency");
    }),
  );
  it.effect("stranded recovery lock explains remote cleanup before authentication", () =>
    Effect.gen(function* () {
      const bridge = {
        ensureSshEnvironment: async () => ({
          type: "ssh-runtime-pending",
          target,
          pending: {
            reason: "contended",
            detail: "recovery-stale",
            replacement: "incompatible",
            requestedVersion: "1.2.3",
            liveVersion: "1.2.2",
          },
        }),
      } as unknown as DesktopBridge;
      const error = yield* consumer(bridge, target).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConnectionTransientError",
        detail:
          "Remote recovery is locked. Remove ~/.goat/ssh-launch/replacement.recovery on the remote host after checking that no GOAT client is replacing this runtime.",
      });
    }),
  );
  it.effect("a runtime that cannot drain is a transient wait, not a block", () =>
    Effect.gen(function* () {
      const bridge = {
        ensureSshEnvironment: async () => ({
          type: "ssh-runtime-pending",
          target,
          pending: {
            reason: "unknown",
            refreshCause: "drain_unavailable",
            replacement: "older",
            requestedVersion: "1.2.3",
            liveVersion: "1.2.2",
          },
        }),
      } as unknown as DesktopBridge;
      const error = yield* consumer(bridge, target).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "remote-unavailable",
        detail:
          "Remote runtime GOAT 1.2.2 can't hand over to GOAT 1.2.3 right now. GOAT retries every 10 minutes.",
      });
    }),
  );
  it.effect("names the runtime a capability replacement waits on", () =>
    Effect.gen(function* () {
      const bridge = {
        ensureSshEnvironment: async () => ({
          type: "ssh-runtime-pending",
          target,
          pending: {
            reason: "busy",
            replacement: "capability",
            requestedVersion: "1.2.3",
            liveVersion: "1.2.3-dev.637a98351",
          },
        }),
      } as unknown as DesktopBridge;
      const error = yield* consumer(bridge, target).pipe(Effect.flip);
      expect(error.detail).toBe(
        "Remote runtime GOAT 1.2.3-dev.637a98351 cannot grant memory access to tasks, so it will be replaced with GOAT 1.2.3 when its work finishes.",
      );
    }),
  );
  it.effect.each(["busy", "unknown", "contended"] as const)(
    "pending %s stops before authentication or descriptor calls",
    (reason) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const pending: DesktopSshRuntimePendingResult = {
          type: "ssh-runtime-pending",
          target,
          pending: {
            reason,
            replacement: "incompatible",
            requestedVersion: "1.2.3",
            liveVersion: "1.2.2",
          },
        };
        const bridge = {
          ensureSshEnvironment: async () => {
            calls.push("ensure");
            return pending;
          },
          fetchSshEnvironmentDescriptor: async () => {
            calls.push("descriptor");
            throw new Error("Unexpected descriptor");
          },
          bootstrapSshBearerSession: async () => {
            calls.push("bearer");
            throw new Error("Unexpected bearer");
          },
        } as unknown as DesktopBridge;
        const error = yield* consumer(bridge, target).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ConnectionTransientError",
          reason: "remote-unavailable",
          detail: messages[reason],
        });
        expect(calls).toEqual(["ensure"]);
      }),
  );
});

describe("Desktop SSH runtime gateway", () => {
  it.effect("returns a typed unsupported result without the owning desktop bridge", () =>
    Effect.gen(function* () {
      expect(yield* readDesktopSshRuntime(undefined, target)).toEqual({
        kind: "error",
        code: "unsupported",
        message: "SSH runtime updates need the desktop app that owns this SSH connection.",
      });
    }),
  );
  it.effect("routes status and both update modes to the original target", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const ownerTarget = { alias: "box", hostname: "10.0.0.2", username: "ops", port: 2222 };
      const reply = {
        kind: "ok",
        status: { host: "box", state: "ready", runtimeVersion: "1.2.3", requestedVersion: "1.2.3" },
      } as const;
      const bridge = {
        getSshHostStatus: async (value: DesktopSshEnvironmentTarget) => {
          calls.push(["status", value]);
          return reply;
        },
        updateSshRuntime: async (
          value: DesktopSshEnvironmentTarget,
          mode?: "when_idle" | "now",
        ) => {
          calls.push([mode, value]);
          return reply;
        },
      };
      yield* readDesktopSshRuntime(bridge, ownerTarget);
      yield* readDesktopSshRuntime(bridge, ownerTarget, "when_idle");
      yield* readDesktopSshRuntime(bridge, ownerTarget, "now");
      expect(calls).toEqual([
        ["status", ownerTarget],
        ["when_idle", ownerTarget],
        ["now", ownerTarget],
      ]);
    }),
  );
  it.effect("does not turn malformed IPC into a ready runtime", () =>
    Effect.gen(function* () {
      const bridge = {
        getSshHostStatus: async () => ({ kind: "ok", status: { state: "ready" } }),
      } as unknown as DesktopBridge;
      expect(yield* readDesktopSshRuntime(bridge, target)).toMatchObject({
        kind: "error",
        code: "operation_failed",
      });
    }),
  );
});

describe("scoped SSH preparation reporting", () => {
  const uploading = {
    operationId: "op-1",
    phase: "uploading" as const,
    hostAnswered: true,
    remainingMs: 899_000,
  };
  const terminal = {
    operationId: "op-1",
    phase: null,
    hostAnswered: true,
    remainingMs: 898_000,
    outcome: "pending" as const,
  };
  const pending: DesktopSshRuntimePendingResult = {
    type: "ssh-runtime-pending",
    target,
    pending: {
      reason: "busy",
      replacement: "older",
      liveVersion: "1.0.0",
      requestedVersion: "2.0.0",
    },
  };

  it.effect("drains sparse phase and terminal reports before settling pending", () =>
    Effect.gen(function* () {
      const received: unknown[] = [];
      const reporterEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const bridge = {
        supportsSshPreparationPhases: true,
        ensureSshEnvironment: async (_target, options) => {
          options?.onPreparationProgress?.(uploading);
          options?.onPreparationProgress?.(terminal);
          return pending;
        },
      } as DesktopBridge;
      const fiber = yield* provisionDesktopSshEnvironment(bridge, target, undefined, {
        onPreparationProgress: (progress) =>
          Effect.gen(function* () {
            received.push(progress);
            if (progress.phase !== null) {
              yield* Deferred.succeed(reporterEntered, undefined);
              yield* Deferred.await(release);
            }
          }),
      }).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(reporterEntered);
      expect(received).toEqual([uploading]);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      expect(received).toEqual([uploading, terminal]);
    }),
  );

  it.effect("stops local delivery after interruption while the native invocation can settle", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let deliver: Parameters<DesktopBridge["ensureSshEnvironment"]>[1];
      let finish!: () => void;
      const received: unknown[] = [];
      const bridge = {
        supportsSshPreparationPhases: true,
        ensureSshEnvironment: (_target, options) =>
          new Promise((resolve) => {
            deliver = options;
            finish = () => resolve(pending);
            Deferred.doneUnsafe(entered, Effect.void);
          }),
      } as DesktopBridge;
      const fiber = yield* provisionDesktopSshEnvironment(bridge, target, undefined, {
        onPreparationProgress: (progress) =>
          Effect.sync(() => {
            received.push(progress);
          }),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      deliver?.onPreparationProgress?.(uploading);
      deliver?.onPreparationProgress?.(terminal);
      finish();
      expect(received).toEqual([]);
    }),
  );

  it.effect("never clones callback or attachment metadata into an older bridge", () =>
    Effect.gen(function* () {
      let options: unknown;
      const bridge = {
        ensureSshEnvironment: async (_target, request) => {
          options = structuredClone(request);
          return pending;
        },
      } as DesktopBridge;
      yield* provisionDesktopSshEnvironment(bridge, target, undefined, {
        onPreparationProgress: () => Effect.die("must not be delivered"),
        preparedAttachmentId: "old-bridge-must-not-receive",
        attemptContext: { supervisorId: "supervisor-1", attemptId: 1, routeId: "route-1" },
      }).pipe(Effect.result);
      expect(options).toEqual({ issuePairingToken: true });
    }),
  );
});
