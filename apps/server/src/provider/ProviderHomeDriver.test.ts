import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
} from "@goat/contracts";
import type { ProviderDriver, ProviderInstance } from "@goat/provider-core/server/driver";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { PiSettings } from "@goat/provider-pi/settings";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "../config.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import * as Routes from "./CodexRouteService.ts";
import { withProviderHomeRoute } from "./ProviderHomeDriver.ts";

const instanceId = ProviderInstanceId.make("pi");
const decodePi = Schema.decodeUnknownSync(PiSettings);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const HOME = "http://127.0.0.1:10100/v1";

/** A provider at its process boundary: it records each launch environment and session open. */
const fakeDriver = () => {
  const launches: Array<ProviderInstanceEnvironment> = [];
  const opened: Array<string> = [];
  const driver: ProviderDriver<PiSettings> = {
    driverKind: ProviderDriverKind.make("pi"),
    metadata: { displayName: "Pi" },
    configSchema: PiSettings,
    defaultConfig: () => decodePi({}),
    create: (input) =>
      Effect.sync(() => {
        launches.push(input.environment);
        const snapshot = decodeProvider({
          instanceId: input.instanceId,
          driver: "pi",
          enabled: true,
          installed: true,
          version: "fixture",
          status: "ready",
          auth: { status: "unknown" },
          checkedAt: "2026-10-27T00:00:00.000Z",
          models: [],
        });
        return {
          instanceId: input.instanceId,
          driverKind: ProviderDriverKind.make("pi"),
          snapshot: {
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            streamChanges: Stream.make(snapshot),
          },
          orchestrationAdapter: {
            openSession: (session: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.sync(() => {
                opened.push(session.modelSelection.model);
                return {} as ProviderAdapter.ProviderAdapterV2SessionRuntime;
              }),
          },
          textGeneration: {},
        } as unknown as ProviderInstance;
      }),
  };
  return { driver: withProviderHomeRoute("pi", driver), launches, opened };
};

/** This machine's OpenCodex: a linked listener whose Pi export lists the given Home models. */
const layerOpenCodex = (models: () => ReadonlyArray<string>) =>
  Layer.mergeAll(
    Routes.layerState,
    Layer.mock(Inventory.OpenCodexInventory)({
      readParity: Effect.succeed({
        ...fleetSnapshot("mac-studio"),
        binaries: [{ path: "/fixture/ocx", version: "2.92.0" }],
      }),
    }),
    Layer.mock(Runner.ProcessRunner)({
      run: () =>
        Effect.sync(() => ({
          stdout: JSON.stringify({
            providers: {
              opencodex: {
                baseUrl: HOME,
                api: "openai-completions",
                models: models().map((id) => ({ id })),
              },
            },
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        })),
    }),
    Config.layerTest(process.cwd(), { prefix: "provider-home-driver-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const create = (
  driver: ReturnType<typeof fakeDriver>["driver"],
  config: Readonly<Record<string, unknown>>,
) =>
  driver
    .create({
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: decodePi(config),
    })
    .pipe(Effect.provideService(HostProcess.Environment, {}));
const open = (instance: ProviderInstance, model: string) =>
  Effect.scoped(
    instance.orchestrationAdapter.openSession({
      modelSelection: { instanceId, model },
    } as ProviderAdapter.ProviderAdapterV2OpenSessionInput),
  ).pipe(Effect.result);
const settingsWith = (entry: ProviderInstanceConfig | undefined) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: entry === undefined ? {} : { [instanceId]: entry },
});

it.effect(
  "keeps a runtime admitted when an identical implicit default is materialized or rebuilt",
  () =>
    Effect.gen(function* () {
      const state = yield* Routes.CodexRouteState;
      const { driver, opened } = fakeDriver();
      const live = yield* create(driver, {});
      // Saving the implicit default as an explicit entry changes settings, not the effective entry.
      yield* state.committed(
        settingsWith(undefined),
        settingsWith({ driver: ProviderDriverKind.make("pi") }),
      );
      assert.equal((yield* open(live, "native/model"))._tag, "Success");
      yield* create(driver, {});
      assert.equal((yield* open(live, "native/model"))._tag, "Success");
      yield* create(driver, { launchArgs: "--verbose" });
      assert.equal((yield* open(live, "native/model"))._tag, "Failure");
      assert.deepEqual(opened, ["native/model", "native/model"]);
    }).pipe(Effect.provide(layerOpenCodex(() => [])), Effect.scoped),
);
