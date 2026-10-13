import { describe, expect, it } from "@effect/vitest";
import type { DesktopBridge, DesktopSshRuntimePendingResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { prepareDesktopSshEnvironment, provisionDesktopSshEnvironment } from "./platform.ts";

const target = { alias: "box", hostname: "box.test", username: null, port: null };
const messages = {
  busy: "Remote runtime will be replaced when its work finishes.",
  unknown:
    "Remote runtime will be replaced when its work finishes. Waiting for a verified idle response.",
  contended: "Another client is replacing the remote runtime.",
};
describe.each([
  { label: "existing SSH connection", consumer: prepareDesktopSshEnvironment },
  { label: "new SSH connection", consumer: provisionDesktopSshEnvironment },
])("$label", ({ consumer }) => {
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
