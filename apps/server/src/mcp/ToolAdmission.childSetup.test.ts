import { expect, it } from "@effect/vitest";
import {
  type ChildReadyConnectionInput,
  ChildReadyConnectionResult,
  type ChildReadyDeviceResult,
  type ChildReadyPrepareInput,
  type ChildSetupPurpose,
  EnvironmentId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { McpSchema, McpServer } from "effect/ai";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as UpdateHost from "../hub/OpenCodexUpdateHost.ts";
import { makeChildConnection } from "../opencodex/childConnection.ts";
import * as ChildReady from "../opencodex/OpenCodexChildReady.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  catalog,
  client as catalogClient,
  dependencies as catalogDependencies,
} from "./agentSurface.testkit.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as Invocation from "./McpInvocationContext.ts";

const decodeConnection = Schema.decodeUnknownSync(ChildReadyConnectionResult);

/**
 * The served catalog, tool admission and the production connection builder; doubles stop at
 * native ocx, device observations, proof persistence and the idle fence.
 */
const fixture = Effect.gen(function* () {
  const destination = EnvironmentId.make("j2-child");
  const home = EnvironmentId.make("j2-home");
  const now = yield* Clock.currentTimeMillis;
  const purpose: ChildSetupPurpose = {
    purpose: "opencodex-child-setup",
    destinationEnvironmentId: destination,
    homeEnvironmentId: home,
    operationId: "j2-operation",
    grantId: "j2-consent",
    grantRevision: 1,
    issuedAt: now,
    phase: "installOpenCodex",
    phaseId: "j2-phase",
    phaseDeadline: now + 15 * 60_000,
    expiresAt: now + 20 * 60_000,
  };
  const ordinary: McpInvocationContext.McpInvocationScope = {
    environmentId: destination,
    requestNamespace: "client:j2",
    issuedAt: now,
    capabilities: new Set(["orchestration"]),
    thread: undefined,
    client: { sessionId: "j2-session", label: "J2", access: "full-access" },
    grantedScopes: ["orchestration:read", "orchestration:operate"],
    reauthorize: () => Effect.void,
  };
  const setup = { ...ordinary, childSetupPurpose: purpose };
  const address = { destinationEnvironmentId: destination, homeEnvironmentId: home };
  const pairingCode = "ocx_pair_J2_SYNTHETIC_CODE_1234567890";
  const connect: ChildReadyConnectionInput = {
    ...address,
    operationId: "j2-operation",
    opencodexConnection: {
      kind: "connectHubClient",
      dataUrl: "https://data.example.test",
      managementUrl: "https://management.example.test",
      pairingCode,
    },
  };
  const writes: Array<ProcessRunner.ProcessRunInput> = [];
  const logs: Array<string> = [];
  const prepareRuns = yield* Ref.make(0);
  const invalidations = yield* Ref.make(0);
  let failNext = false;
  let state: ChildReadyDeviceResult = {
    kind: "device",
    ...address,
    revision: { epoch: "j2-epoch", sequence: 0 },
    device: {
      platform: "win32",
      arch: "x64",
      ocx: { path: "C:\\fixture\\ocx.exe", version: "2.92.0", ownership: "managed" },
      connection: { role: "standalone" },
    },
    healthy: true,
  };
  const readDevice = () => Effect.sync(() => state);
  const boundary = Layer.mergeAll(
    catalogDependencies,
    Profiles.layer.pipe(
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(
        ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile: "owner" } }),
      ),
    ),
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Effect.suspend(() => {
          writes.push(input);
          if (failNext)
            return Effect.fail(
              new ProcessRunner.ProcessStdinError({
                command: input.command,
                argumentCount: input.args.length,
                stdinBytes: input.stdin?.length ?? 0,
                cause: new Error(pairingCode),
              }),
            );
          state = {
            ...state,
            device: {
              ...state.device,
              connection:
                input.args[0] === "connect"
                  ? { role: "client", linkId: "j2-link" }
                  : { role: "standalone" },
            },
          };
          return Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdout: pairingCode,
            stderr: pairingCode,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        }),
    }),
    Layer.mock(UpdateHost.OpenCodexUpdateHost)({
      holdAdmission: () => Effect.succeed(true),
      releaseAdmission: () => Effect.void,
      member: () => Effect.succeed({ alias: null, runningTurns: 0, snapshot: undefined } as never),
    }),
    Layer.mock(Inventory.OpenCodexInventory)({ readParity: Effect.succeed(fleetSnapshot("home")) }),
  );
  const child = Layer.effect(
    ChildReady.OpenCodexChildReady,
    Effect.gen(function* () {
      const connection = yield* makeChildConnection({
        destinationEnvironmentId: destination,
        profiles: yield* Profiles.PermissionProfiles,
        runner: yield* ProcessRunner.ProcessRunner,
        host: yield* UpdateHost.OpenCodexUpdateHost,
        inventory: yield* Inventory.OpenCodexInventory,
        readDevice,
        invalidateProof: () => Ref.update(invalidations, (n) => n + 1),
        environment: {},
      });
      return ChildReady.OpenCodexChildReady.of({
        connection,
        status: readDevice,
        prepare: () => Ref.update(prepareRuns, (n) => n + 1).pipe(Effect.as(state)),
      });
    }),
  ).pipe(Layer.provide(boundary));
  const served = catalog.pipe(
    Layer.provideMerge(Layer.mergeAll(boundary, child)),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Logger.layer([Logger.make(({ message }) => logs.push(String(message)))], {
        mergeWithExisting: false,
      }),
    ),
  );
  const call = (
    name: string,
    input: ChildReadyConnectionInput | ChildReadyPrepareInput,
    invocation: McpInvocationContext.McpInvocationScope = ordinary,
  ) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: { ...input } })),
      Effect.provideService(McpSchema.McpServerClient, catalogClient),
      Effect.provideService(Invocation.McpInvocationContext, invocation),
    );
  const resultOf = (result: McpSchema.CallToolResult) =>
    decodeConnection(
      JSON.parse(result.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    );
  return {
    served,
    setup,
    address,
    connect,
    pairingCode,
    writes,
    logs,
    call,
    resultOf,
    prepareRuns: Ref.get(prepareRuns),
    invalidations: Ref.get(invalidations),
    failNative: () => {
      failNext = true;
    },
  };
});

it.effect(
  "refuses a purpose session at goat_hub_child_connection even with ordinary write grants",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const refused = yield* f.call("goat_hub_child_connection", f.connect, f.setup);
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused)).toContain("capability_denied");
        const service = yield* ChildReady.OpenCodexChildReady;
        expect((yield* Effect.result(service.connection(f.connect, f.setup)))._tag).toBe("Failure");
        expect(f.writes).toHaveLength(0);
        expect(yield* f.invalidations).toBe(0);
      }).pipe(Effect.provide(f.served));
    }),
);

it.effect("refuses an ordinary hub.manage session at goat_hub_child_prepare", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const refused = yield* f.call("goat_hub_child_prepare", {
        ...f.address,
        operationId: "j2-operation",
        action: "installOpenCodex",
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("capability_denied");
      expect(yield* f.prepareRuns).toBe(0);
      expect(f.writes).toHaveLength(0);
    }).pipe(Effect.provide(f.served));
  }),
);

it.effect("dispatches a hidden Child prepare tool for a live read-only purpose session", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const scope: McpInvocationContext.McpInvocationScope = {
      ...f.setup,
      readOnly: true,
      grantedScopes: ["orchestration:read"],
      client: { sessionId: "j2-session", label: "J2", access: "read-only" },
    };
    yield* Effect.gen(function* () {
      const answer = yield* f.call(
        "goat_hub_child_prepare",
        { ...f.address, operationId: "j2-operation", action: "installOpenCodex" },
        scope,
      );
      expect(answer.isError).not.toBe(true);
      expect(yield* f.prepareRuns).toBe(1);
      expect(f.writes).toHaveLength(0);
    }).pipe(Effect.provide(f.served));
  }),
);

it.effect(
  "an ordinary hub.manage session connects disconnects and restarts through goat_hub_child_connection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        for (const op of [
          f.connect.opencodexConnection,
          { kind: "disconnect", expectedLinkId: "j2-link" },
          { kind: "restart", expectedLinkId: "j2-link" },
        ] as const) {
          const result = yield* f.call("goat_hub_child_connection", {
            ...f.address,
            operationId: "j2-operation",
            opencodexConnection: op,
          });
          expect(result.isError).not.toBe(true);
          expect(f.resultOf(result)).toEqual({
            ...f.address,
            operationId: "j2-operation",
            kind: op.kind,
            code: 0,
            healthy: true,
          });
        }
        expect(f.writes.map(({ args }) => args[0])).toEqual(["connect", "disconnect", "restart"]);
        expect(yield* f.invalidations).toBe(3);
        expect(yield* f.prepareRuns).toBe(0);
      }).pipe(Effect.provide(f.served));
    }),
);

it.effect.each([false, true])(
  "a pairing code reaches native stdin but never argv, logs or results (native failure: %s)",
  (fail) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (fail) f.failNative();
      yield* Effect.gen(function* () {
        const result = yield* f.call("goat_hub_child_connection", f.connect);
        expect(result.isError === true).toBe(fail);
        expect(f.writes).toHaveLength(1);
        expect(f.writes[0]?.stdin).toBe(`${f.pairingCode}\n`);
        expect(f.writes[0]?.args).toContain("--pairing-code-stdin");
        expect(
          JSON.stringify(f.writes.map(({ command, args }) => ({ command, args }))),
        ).not.toContain(f.pairingCode);
        expect(JSON.stringify(result)).not.toContain(f.pairingCode);
        expect(JSON.stringify(f.logs)).not.toContain(f.pairingCode);
      }).pipe(Effect.provide(f.served));
    }),
);
