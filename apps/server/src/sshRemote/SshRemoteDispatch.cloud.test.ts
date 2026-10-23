import { EnvironmentId } from "@goat/contracts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  options: {
    readonly ready?: CloudMachineErrorReason;
    readonly stdout?: string;
    readonly profile?: string;
  },
  body: (dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const scripts: Array<{ readonly script: string; readonly timeoutMs?: number }> = [];
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
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: () => Effect.die("unused"),
      runRemoteScript: (target, input) =>
        Effect.sync(() => {
          events.push(`ssh:${target.alias}`);
          scripts.push(input);
        }).pipe(
          Effect.andThen(
            options.stdout === undefined
              ? Effect.fail(sshFailure)
              : Effect.succeed({ stdout: options.stdout, stderr: "" }),
          ),
        ),
    });
    const cloud = {
      owns: (alias: string) => Effect.succeed(alias === OWNED),
      catalog: Effect.succeed([{ alias: OWNED, label: "owned" }]),
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
            Layer.provide(
              ServerSettings.layerTest({
                goatclaw: {
                  enabled: options.profile !== undefined,
                  defaultProfile: options.profile ?? "worker",
                },
              }),
            ),
            Layer.provide(Sqlite.layerMemory),
            Layer.provide(Layer.succeed(CloudMachineService.CloudMachineService, cloud)),
            Layer.provide(
              ServerConfig.layerTest("/fixture", { prefix: "goat-dispatch-cloud-test-" }),
            ),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      return { result, events, listeners, scripts };
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

  it.effect(
    "dials another server's machine and probes SSH hosts, listing owned machines unprobed",
    () =>
      Effect.gen(function* () {
        const { result, events } = yield* withDispatch({}, (dispatch) =>
          hostCall(FOREIGN)(dispatch).pipe(
            Effect.ignore,
            Effect.andThen(dispatch.listHosts({ probe: true })),
          ),
        );
        expect(events).toEqual([`ensureEnvironment:${FOREIGN}`, `ssh:${FOREIGN}`]);
        expect(result).toMatchObject({
          _tag: "Success",
          success: [
            { alias: FOREIGN, source: "ssh-config", reachable: false },
            { alias: OWNED, source: "cloud-machine" },
          ],
        });
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

it.effect(
  "identifies an owned target with a read-only script and quiet readiness, without ensuring a runtime",
  () =>
    Effect.gen(function* () {
      const { result, events, scripts } = yield* withDispatch(
        { stdout: "env-remote\n" },
        (dispatch) =>
          dispatch.identifyTarget({ alias: OWNED, hostname: OWNED, username: null, port: null }),
      );
      expect(result).toMatchObject({ _tag: "Success", success: "env-remote" });
      expect(events).toEqual([`ready:${OWNED}:quiet`, `ssh:${OWNED}`]);
      expect(scripts).toEqual([
        {
          script:
            'if [ -f "$HOME/.goat/userdata/environment-id" ]; then cat "$HOME/.goat/userdata/environment-id"; fi',
          timeoutMs: 15_000,
        },
      ]);
      expect(scripts[0]!.script).not.toContain(".t3");
    }),
);

it.effect("returns unknown identity when the read-only identity file is absent", () =>
  Effect.gen(function* () {
    const { result, events } = yield* withDispatch({ stdout: "" }, (dispatch) =>
      dispatch.identifyTarget({ alias: FOREIGN, hostname: FOREIGN, username: null, port: null }),
    );
    expect(result).toMatchObject({ _tag: "Success", success: null });
    expect(events).toEqual([`ssh:${FOREIGN}`]);
  }),
);

it.effect("does not SSH to an owned target that quiet readiness refuses", () =>
  Effect.gen(function* () {
    const { result, events } = yield* withDispatch(
      { ready: "stopped", stdout: "env-remote" },
      (dispatch) =>
        dispatch.identifyTarget({ alias: OWNED, hostname: OWNED, username: null, port: null }),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "host_unavailable" } });
    expect(events).toEqual([`ready:${OWNED}:quiet`]);
  }),
);

it.effect.each(["manager", "owner"])(
  "implicit Boat wake enforces profile %s before paid effects",
  (profile) =>
    Effect.gen(function* () {
      const { result, events } = yield* withDispatch({ profile }, (dispatch) =>
        dispatch.browse({ host: OWNED }).pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("test"),
            requestNamespace: "test",
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
            thread: undefined,
            client: { sessionId: "test", label: "test", access: "full-access" },
          }),
        ),
      );
      if (profile === "manager") {
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "remote_refused" } });
        expect(events).toHaveLength(0);
      } else expect(events[0]).toBe(`ready:${OWNED}:wake`);
    }),
);
