import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import type { SshHostResult } from "@goat/contracts";
import * as SshConfig from "@goat/ssh/config";
import { SshLaunchError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as PermissionSettings from "../serverSettings.ts";
import * as SshHostSetup from "./SshHostSetup.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import { dependencies } from "./testkit/SshHostSetupTestkit.ts";
import { target, stopped, invocation } from "./testkit/SshRuntimeUpdateFixture.ts";

it.effect("shares the dispatch manager", () =>
  Effect.gen(function* () {
    let snapshot: SshHostResult = { kind: "ok", status: stopped };
    let ensures = 0;
    const manager = SshTunnel.SshEnvironmentManager.of({
      readyEnvironment: () => Effect.die("Unexpected ready environment"),
      beginSetupOperation: () =>
        Effect.sync(() => {
          const setup = { operationId: "operation", generation: 1, stage: "runtime" as const };
          snapshot = { kind: "ok", status: { ...stopped, setup } };
          return setup;
        }),
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
      forgetEnvironment: () => Effect.die("Unexpected forget"),
      status: () => Effect.sync(() => snapshot),
      ensureEnvironment: (received, options) =>
        Effect.gen(function* () {
          ensures++;
          expect(received).toEqual(target);
          expect(options).toEqual({
            keyOnly: true,
            issuePairingToken: false,
            refreshRuntime: true,
            confirmReplacement: false,
            onPhase: expect.any(Function),
          });
          snapshot = {
            kind: "ok",
            status: {
              ...stopped,
              state: "failed",
              failure: {
                reason: "archive_unavailable",
                archive: {
                  requestedVersion: stopped.requestedVersion,
                  platformKey: "linux-x64",
                  sourcesTried: ["https"],
                },
                fix: {
                  actor: "human",
                  instruction: "Install a published GOAT release, or set a release mirror.",
                },
              },
            },
          };
          return yield* new SshLaunchError({
            reason: "archive-unavailable",
            message: "No archive",
            stdout: "",
          });
        }),
      disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
      revalidateTunnels: () => Effect.void,
      closeAllTunnels: Effect.void,
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: () => Effect.die("Unexpected pairing/session mutation"),
      runRemoteScript: () => Effect.die("Unexpected remote command"),
    });
    const discover = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    try {
      yield* Effect.gen(function* () {
        const setup = yield* SshHostSetup.SshHostSetup;
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        expect(yield* setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
        const result = yield* setup.update({ host: "box" }, { kind: "mcp", scope: invocation });
        expect(result).toMatchObject({
          kind: "ok",
          status: { state: "failed", failure: { reason: "archive_unavailable" } },
        });
        expect(yield* dispatch.runtimeStatus("box")).toEqual(result);
        expect(yield* setup.status({ host: "box" })).toEqual(result);
        expect(ensures).toBe(1);
        expect(
          yield* setup.update({ host: "unknown" }, { kind: "mcp", scope: invocation }),
        ).toMatchObject({ kind: "error", code: "host_unknown" });
        expect(ensures).toBe(1);
      }).pipe(
        Effect.provide(
          SshHostSetup.layer.pipe(
            Layer.provideMerge(
              SshRemoteDispatch.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
            ),
            Layer.provide(dependencies),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "ssh-host-setup-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      );
    } finally {
      managerLayer.mockRestore();
      discover.mockRestore();
    }
  }),
);
