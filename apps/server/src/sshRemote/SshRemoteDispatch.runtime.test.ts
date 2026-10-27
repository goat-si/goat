import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const target = { alias: "build-box", hostname: "build-box", username: null, port: null };
const EXECUTABLE = "/home/agent/.goat/runtime/goat/versions/1.2.3/goat";

/** The real dispatch over a scripted manager; `pending` makes every ensure answer pending. */
const withDispatch = <A, E>(
  pending: boolean,
  use: (dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const ensures: Array<SshTunnel.SshEnvironmentEnsureOptions | undefined> = [];
    const unused = () => Effect.die("Unexpected manager call");
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: unused,
      ensureEnvironment: (_target, options) => {
        ensures.push(options);
        return Effect.succeed(
          pending
            ? {
                type: "ssh-runtime-pending" as const,
                target,
                pending: {
                  reason: "busy" as const,
                  replacement: "incompatible" as const,
                  requestedVersion: "1.2.3",
                  liveVersion: "1.2.2",
                },
              }
            : {
                target,
                httpBaseUrl: "http://build-box:3773/",
                wsBaseUrl: "ws://build-box:3773/",
                pairingToken: null,
              },
        );
      },
      readyEnvironment: unused,
      beginSetupOperation: unused,
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: unused,
      forgetEnvironment: unused,
      disconnectEnvironment: unused,
      revalidateTunnels: () => Effect.void,
      issueClientSession: unused,
      issueMcpClientSession: unused,
      runRemoteScript: unused,
      // A pending runtime has no attachment, so the manager resolves nothing for it.
      provisionedRuntimeExecutable: () => Effect.succeed(pending ? undefined : EXECUTABLE),
    });
    const discover = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    try {
      const result = yield* SshRemoteDispatch.SshRemoteDispatch.pipe(
        Effect.flatMap(use),
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-runtime-test-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      return { result, ensures };
    } finally {
      managerLayer.mockRestore();
      discover.mockRestore();
    }
  });

describe("SSH dispatch runtime for Child preparation", () => {
  it.effect("ensures a runtime before resolving its executable without forcing a replacement", () =>
    Effect.gen(function* () {
      const { result, ensures } = yield* withDispatch(false, (dispatch) =>
        Effect.all([
          dispatch.ensureRuntime("build-box"),
          dispatch.provisionedRuntimeExecutable("build-box"),
        ]),
      );
      expect(result).toEqual([true, EXECUTABLE]);
      // Ensuring attaches to what the host runs; it never replaces it or mints a pairing token.
      expect(ensures).toEqual([
        { keyOnly: true, issuePairingToken: false, reuseWhileRefreshPending: true },
      ]);
    }),
  );

  it.effect("leaves a pending runtime unavailable for Child preparation", () =>
    Effect.gen(function* () {
      const { result, ensures } = yield* withDispatch(true, (dispatch) =>
        Effect.all([
          dispatch.ensureRuntime("build-box"),
          dispatch.provisionedRuntimeExecutable("build-box"),
        ]),
      );
      expect(result).toEqual([false, undefined]);
      expect(ensures).toHaveLength(1);
    }),
  );
});
