import * as ServerSettings from "../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import { SshPairingError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const target = { alias: "build-box", hostname: "build-box", username: null, port: null };
describe("SSH dispatch pending runtime", () => {
  it.effect.each(
    (["launch", "tool", "preflight"] as const).flatMap((operation) =>
      [false, true].map((recovery) => ({ operation, recovery })),
    ),
  )(
    "pending $operation recovery=$recovery issues no session, registers no connected host, and sends no MCP",
    ({ operation, recovery }) =>
      Effect.gen(function* () {
        let sessions = 0;
        const manager = SshTunnel.SshEnvironmentManager.of({
          status: () => Effect.die("Unexpected runtime status"),
          ensureEnvironment: () =>
            Effect.succeed({
              type: "ssh-runtime-pending",
              target,
              pending: {
                reason: recovery ? "contended" : "busy",
                ...(recovery ? { detail: "recovery-stale" as const } : {}),
                replacement: "incompatible",
                requestedVersion: "1.2.3",
                liveVersion: "1.2.2",
              },
            }),
          readyEnvironment: () => Effect.die("Unexpected ready environment"),
          beginSetupOperation: () => Effect.die("Unexpected setup operation"),
          publishSetupOutcome: () => Effect.succeed(true),
          publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
          forgetEnvironment: () => Effect.die("Unexpected forget"),
          disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
          revalidateTunnels: () => Effect.void,
          issueClientSession: () => Effect.die("unused"),
          issueMcpClientSession: () => {
            sessions++;
            return Effect.die("Unexpected session");
          },
          runRemoteScript: () =>
            Effect.succeed({
              stdout:
                "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
              stderr: "",
            }),
        });
        const discover = vi
          .spyOn(SshConfig, "discoverSshHosts")
          .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
        const managerLayer = vi
          .spyOn(SshTunnel.SshEnvironmentManager, "layer")
          .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
        const remoteFetch = vi.fn(() => Promise.reject(new Error("Unexpected MCP")));
        vi.stubGlobal("fetch", remoteFetch);
        try {
          const result = yield* Effect.gen(function* () {
            const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
            const failed = yield* operation === "preflight"
              ? dispatch
                  .preflightTarget({
                    target,
                    runtimeMode: "full-access",
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "model",
                    },
                  })
                  .pipe(Effect.result)
              : operation === "launch"
                ? dispatch
                    .launchThread<never, never>(
                      {
                        host: target.alias,
                        cwd: "/home/agent/repo",
                        workspace: { type: "cwd" },
                        title: "pending",
                        runtimeMode: "approval-required",
                        callerRuntimeMode: "approval-required",
                      },
                      Effect.void,
                    )
                    .pipe(Effect.result)
                : dispatch
                    .callHostTool<never, never>(
                      {
                        host: target.alias,
                        tool: "goat_thread_read",
                        arguments: {},
                        timeoutMs: 5000,
                        writes: false,
                      },
                      Effect.succeed("full-access"),
                    )
                    .pipe(Effect.result);
            if (failed._tag !== "Failure") throw new Error("Expected pending dispatch failure");
            return { failed: failed.failure, connected: yield* dispatch.connectedHosts };
          }).pipe(
            Effect.provide(
              SshRemoteDispatch.layer.pipe(
                Layer.provide(ServerSettings.layerTest()),
                Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-pending-test-" })),
                Layer.provide(FetchHttpClient.layer),
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
          expect(result.failed.reason).toBe("host_unavailable");
          expect(result.failed.message).toContain(
            recovery
              ? "Remove ~/.goat/ssh-launch/replacement.recovery"
              : "being replaced when its current work finishes",
          );
          expect(result.connected).toEqual([]);
          expect(sessions).toBe(0);
          expect(remoteFetch).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
          managerLayer.mockRestore();
          discover.mockRestore();
        }
      }),
  );
});

describe("SSH dispatch memory session refusal", () => {
  it.effect("reports the remote runtime that cannot grant memory instead of an SSH failure", () =>
    Effect.gen(function* () {
      const refusal = new SshPairingError({
        reason: "memory-scopes-unsupported",
        message:
          "GOAT 0.1.0-dev.637a98351 on build-box cannot grant memory access to tasks. It will be replaced with GOAT 0.1.0-dev.37d2df283 when its current work finishes.",
        stdout: "GOAT_SESSION_ERROR=memory_scopes_unsupported runtime=0.1.0-dev.637a98351\n",
      });
      const manager = SshTunnel.SshEnvironmentManager.of({
        status: () => Effect.die("Unexpected runtime status"),
        ensureEnvironment: () =>
          Effect.succeed({
            target,
            httpBaseUrl: "http://127.0.0.1:9/",
            wsBaseUrl: "ws://127.0.0.1:9/",
            pairingToken: null,
            remotePort: 3774,
          }),
        readyEnvironment: () => Effect.die("Unexpected ready environment"),
        beginSetupOperation: () => Effect.die("Unexpected setup operation"),
        publishSetupOutcome: () => Effect.succeed(true),
        publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
        forgetEnvironment: () => Effect.die("Unexpected forget"),
        disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
        revalidateTunnels: () => Effect.void,
        issueClientSession: () => Effect.die("unused"),
        issueMcpClientSession: () => Effect.fail(refusal),
        runRemoteScript: () =>
          Effect.succeed({
            stdout:
              "T3B\t1\nHOME\t/home/agent\nOS\tLinux\nPATH\t/home/agent/repo\nREAL\t/home/agent/repo\n",
            stderr: "",
          }),
      });
      const discover = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
      const remoteFetch = vi.fn(() => Promise.reject(new Error("Unexpected MCP")));
      vi.stubGlobal("fetch", remoteFetch);
      try {
        const failed = yield* Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch
            .launchThread<never, never>(
              {
                host: target.alias,
                cwd: "/home/agent/repo",
                workspace: { type: "cwd" },
                title: "memory",
                runtimeMode: "approval-required",
                callerRuntimeMode: "approval-required",
                memoryGrantCeiling: "read",
              },
              Effect.void,
            )
            .pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            SshRemoteDispatch.layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-memory-test-" })),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        expect(failed.reason).toBe("remote_refused");
        expect(failed.message).toBe(refusal.message);
        expect(remoteFetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        managerLayer.mockRestore();
        discover.mockRestore();
      }
    }),
  );
});
