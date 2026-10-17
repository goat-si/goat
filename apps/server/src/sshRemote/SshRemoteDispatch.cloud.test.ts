import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  CloudMachineError,
  type CloudMachineAlias,
  type CloudMachineErrorReason,
} from "@goat/contracts";
import * as SshConfig from "@goat/ssh/config";
import { SshCommandError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../config.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const OWNED = "boat-bx_23456789";
const FOREIGN = "boat-bx_3456789a";

/**
 * Records, in order, every readiness check and SSH operation, so a test can see that a managed
 * machine is made ready before SSH touches it, and that polling paths never wake it.
 */
const withDispatch = <A, E>(
  options: { readonly ready?: CloudMachineErrorReason },
  body: (dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const listeners: Array<(alias: string) => Effect.Effect<void>> = [];
    const sshFailure = new SshCommandError({
      message: "stop here",
      command: ["ssh"],
      exitCode: 255,
      stderr: "",
    });
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: () => Effect.die("Unexpected runtime status"),
      ensureEnvironment: (target) =>
        Effect.sync(() => void events.push(`ensureEnvironment:${target.alias}`)).pipe(
          Effect.andThen(Effect.fail(sshFailure)),
        ),
      readyEnvironment: () => Effect.die("Unexpected ready environment"),
      beginSetupOperation: () => Effect.die("Unexpected setup operation"),
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
      forgetEnvironment: () => Effect.die("Unexpected forget"),
      disconnectEnvironment: (target) =>
        Effect.sync(() => void events.push(`disconnect:${target.alias}`)),
      revalidateTunnels: () => Effect.void,
      issueMcpClientSession: () => Effect.die("unused"),
      runRemoteScript: (target) =>
        Effect.sync(() => void events.push(`ssh:${target.alias}`)).pipe(
          Effect.andThen(Effect.fail(sshFailure)),
        ),
    });
    const cloud = {
      owns: (alias: string) => Effect.succeed(alias === OWNED),
      ensureReady: (alias: CloudMachineAlias, { wake }: CloudMachineService.EnsureReadyOptions) =>
        Effect.sync(() => void events.push(`ready:${alias}:${wake ? "wake" : "quiet"}`)).pipe(
          Effect.andThen(
            options.ready === undefined
              ? Effect.succeed({ alias, endpointChanged: false })
              : Effect.fail(new CloudMachineError({ reason: options.ready })),
          ),
        ),
      onAliasInvalidated: (listener: (alias: string) => Effect.Effect<void>) =>
        Effect.sync(() => void listeners.push(listener)),
    } as unknown as CloudMachineService.CloudMachineService["Service"];
    const discoverHosts = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(
        Effect.succeed([
          { alias: FOREIGN, hostname: FOREIGN, username: null, port: null, source: "ssh-config" },
        ]),
      );
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    try {
      const result = yield* Effect.gen(function* () {
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        return yield* body(dispatch).pipe(Effect.result);
      }).pipe(
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(Layer.succeed(CloudMachineService.CloudMachineService, cloud)),
            Layer.provide(
              ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-cloud-test-" }),
            ),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      return { result, events, listeners };
    } finally {
      managerLayer.mockRestore();
      discoverHosts.mockRestore();
    }
  });

const hostCall = (host: string) => (dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"]) =>
  dispatch.callHostTool(
    { host, tool: "goat_thread_read", arguments: {}, timeoutMs: 1_000, writes: false },
    Effect.succeed("full-access" as const),
  );

describe("SshRemoteDispatch with cloud machines", () => {
  it.effect("readies an owned machine, waking it, before browsing it over SSH", () =>
    Effect.gen(function* () {
      const { events } = yield* withDispatch({}, (dispatch) => dispatch.browse({ host: OWNED }));
      expect(events).toEqual([`ready:${OWNED}:wake`, `ssh:${OWNED}`]);
    }),
  );

  it.effect("checks without waking before a host tool call, which polling also uses", () =>
    Effect.gen(function* () {
      const { events } = yield* withDispatch({}, hostCall(OWNED));
      expect(events).toEqual([`ready:${OWNED}:quiet`, `ensureEnvironment:${OWNED}`]);
    }),
  );

  it.effect("stops before SSH when the machine cannot be readied", () =>
    Effect.gen(function* () {
      const { result, events } = yield* withDispatch({ ready: "stopped" }, hostCall(OWNED));
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "host_unavailable" } });
      expect(events).toEqual([`ready:${OWNED}:quiet`]);
    }),
  );

  it.effect("dials another server's machine and probes hosts as plain SSH", () =>
    Effect.gen(function* () {
      const { events } = yield* withDispatch({}, (dispatch) =>
        hostCall(FOREIGN)(dispatch).pipe(
          Effect.ignore,
          Effect.andThen(dispatch.listHosts({ probe: true })),
        ),
      );
      expect(events).toEqual([`ensureEnvironment:${FOREIGN}`, `ssh:${FOREIGN}`]);
    }),
  );

  it.effect("drops the tunnel of a machine whose address changed", () =>
    Effect.gen(function* () {
      const { events, listeners } = yield* withDispatch({}, () => Effect.void);
      expect(listeners).toHaveLength(1);
      yield* listeners[0]!(OWNED);
      expect(events).toEqual([`disconnect:${OWNED}`]);
    }),
  );
});
