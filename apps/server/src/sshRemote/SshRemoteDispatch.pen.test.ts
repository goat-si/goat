import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { SshCommandError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as PenManagedRoutes from "../hubNodes/PenManagedRoutes.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const binding = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
const unused = () => Effect.die("unused");

it.effect("a Pen route whose tunnel would not close fails its cleanup, so it stays blocked", () =>
  Effect.gen(function* () {
    const closeFails = new SshCommandError({
      message: "control socket busy",
      command: ["ssh", "-O", "exit"],
      exitCode: 255,
      stderr: "",
    });
    const managerLayer = vi.spyOn(SshTunnel.SshEnvironmentManager, "layer").mockReturnValue(
      Layer.succeed(SshTunnel.SshEnvironmentManager, {
        status: unused,
        ensureEnvironment: unused,
        readyEnvironment: unused,
        beginSetupOperation: unused,
        publishSetupOutcome: unused,
        publishProviderDiagnosis: unused,
        forgetEnvironment: unused,
        disconnectEnvironment: () => Effect.fail(closeFails),
        revalidateTunnels: () => Effect.void,
        closeAllTunnels: Effect.void,
        issueClientSession: unused,
        issueMcpClientSession: unused,
        runRemoteScript: unused,
      }),
    );
    const cleanups: Array<PenManagedRoutes.PenRouteCleanup> = [];
    const routes: PenManagedRoutes.PenManagedRoutesShape = {
      isManaged: () => false,
      binding: () => undefined,
      admit: unused,
      hold: () => Effect.void,
      release: () => Effect.void,
      forget: () => Effect.void,
      registerCleanup: (cleanup) => Effect.sync(() => void cleanups.push(cleanup)),
    };
    yield* SshRemoteDispatch.SshRemoteDispatch.pipe(
      Effect.provide(
        SshRemoteDispatch.layer.pipe(
          Layer.provide(Layer.succeed(PenManagedRoutes.PenManagedRoutes, routes)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Sqlite.layerMemory),
          Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-pen-test-" })),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.ensuring(Effect.sync(() => managerLayer.mockRestore())),
    );
    expect(cleanups).toHaveLength(1);
    const exit = yield* Effect.exit(cleanups[0]!(`pen-${binding.nodeId}`, binding));
    expect(exit._tag).toBe("Failure");
  }),
);
