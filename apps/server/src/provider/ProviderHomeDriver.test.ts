import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceEnvironment,
} from "@goat/contracts";
import type { ProviderDriver, ProviderInstance } from "@goat/provider-core/server/driver";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { ThreadTitleGenerationInput } from "@goat/provider-core/server/textGeneration";
import { PiSettings } from "@goat/provider-pi/settings";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "../config.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import * as Routes from "./CodexRouteService.ts";
import { withProviderHomeRoute } from "./ProviderHomeDriver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { reconcileSnapshot } from "./ProviderInstanceRegistryHydration.ts";

const instanceId = ProviderInstanceId.make("pi");
const decodePi = Schema.decodeUnknownSync(PiSettings);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const HOME = "http://127.0.0.1:10100/v1";
type Gate = {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};
const passGate = (gate: Gate | undefined) =>
  gate === undefined
    ? Effect.void
    : Deferred.succeed(gate.started, undefined).pipe(Effect.andThen(Deferred.await(gate.release)));

/**
 * A provider at its process boundary: it records each launch environment, session open and
 * background title generation. driverKind "codex" stands in for a driver the Home route does not wrap.
 */
const fakeDriver = (driverKind: "pi" | "codex", construction?: { gate?: Gate }) => {
  const launches: Array<ProviderInstanceEnvironment> = [];
  const requests: Array<string> = [];
  const driver: ProviderDriver<PiSettings> = {
    driverKind: ProviderDriverKind.make(driverKind),
    metadata: { displayName: driverKind },
    configSchema: PiSettings,
    defaultConfig: () => decodePi({}),
    create: (input) =>
      passGate(construction?.gate).pipe(
        Effect.andThen(
          Effect.sync(() => {
            launches.push(input.environment);
            const snapshot = decodeProvider({
              instanceId: input.instanceId,
              driver: driverKind,
              enabled: true,
              installed: true,
              version: "fixture",
              status: "ready",
              auth: { status: "unknown" },
              checkedAt: "2026-10-27T00:00:00.000Z",
              models: [],
            });
            const record = (entry: string) => Effect.sync(() => void requests.push(entry));
            return {
              instanceId: input.instanceId,
              driverKind: ProviderDriverKind.make(driverKind),
              snapshot: {
                getSnapshot: Effect.succeed(snapshot),
                refresh: Effect.succeed(snapshot),
                streamChanges: Stream.make(snapshot),
              },
              orchestrationAdapter: {
                openSession: (session: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
                  record(`open:${session.modelSelection.model}`).pipe(
                    Effect.as({} as ProviderAdapter.ProviderAdapterV2SessionRuntime),
                  ),
              },
              textGeneration: {
                generateThreadTitle: (title: ThreadTitleGenerationInput) =>
                  record(`title:${title.modelSelection.model}`).pipe(Effect.as({ title: "t" })),
              },
            } as unknown as ProviderInstance;
          }),
        ),
      ),
  };
  return {
    driver: driverKind === "pi" ? withProviderHomeRoute("pi", driver) : driver,
    launches,
    requests,
  };
};

/** This machine's OpenCodex: a linked listener whose Pi export lists the current Home models. */
const layerOpenCodex = (
  models: () => ReadonlyArray<string>,
  options: { readonly exportGate?: Gate; readonly exportFails?: boolean } = {},
) =>
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
        passGate(options.exportGate).pipe(
          Effect.as({
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
            code: ChildProcessSpawner.ExitCode(options.exportFails ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        ),
    }),
    Config.layerTest(process.cwd(), { prefix: "provider-home-driver-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const create = (
  driver: ReturnType<typeof fakeDriver>["driver"],
  config: Readonly<Record<string, unknown>>,
  revision?: Routes.SettingsRevision,
) =>
  driver
    .create({
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: decodePi(config),
    })
    .pipe(
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(Routes.HydratingRevision, revision),
    );
const open = (instance: ProviderInstance, model: string) =>
  Effect.scoped(
    instance.orchestrationAdapter.openSession({
      modelSelection: { instanceId, model },
    } as ProviderAdapter.ProviderAdapterV2OpenSessionInput),
  ).pipe(Effect.result);
const generateTitle = (instance: ProviderInstance) =>
  instance.textGeneration
    .generateThreadTitle({
      cwd: "/fixture",
      message: "fixture",
      modelSelection: { instanceId, model: "native/model" },
    })
    .pipe(Effect.result);
const settingsWith = (entry: ProviderInstanceConfig | undefined) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: entry === undefined ? {} : { [instanceId]: entry },
});
const piEntry = (config: Readonly<Record<string, unknown>> = {}): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  config,
});

/** The server registry over these drivers, hydrated one snapshot at a time as the watcher does. */
const makeRegistry = (drivers: ReadonlyArray<ReturnType<typeof fakeDriver>["driver"]>) =>
  Effect.gen(function* () {
    const { registry, mutator } = yield* makeProviderInstanceRegistry({ drivers, configMap: {} });
    const hydrate = (configMap: ProviderInstanceConfigMap, revision: Routes.SettingsRevision) =>
      reconcileSnapshot(mutator, configMap, revision).pipe(
        Effect.provideService(HostProcess.Environment, {}),
      );
    return { registry, hydrate };
  });
const liveInstance = (registry: Effect.Success<ReturnType<typeof makeRegistry>>["registry"]) =>
  registry.getInstance(instanceId).pipe(
    Effect.filterOrElse(
      (instance): instance is ProviderInstance => instance !== undefined,
      () => Effect.die("Expected a live instance"),
    ),
  );

it.effect("keeps a runtime admitted when an identical implicit default is materialized", () =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    const pi = fakeDriver("pi");
    const { registry, hydrate } = yield* makeRegistry([pi.driver]);
    // Each hydration derives a fresh entry, compared structurally by the registry.
    const implicit = () => ({ [instanceId]: { driver: ProviderDriverKind.make("pi") } });
    yield* hydrate(implicit(), state.revision());
    const live = yield* liveInstance(registry);
    // Saving the implicit default as an explicit entry changes settings, not the effective entry.
    const revision = yield* state.committed(
      settingsWith(undefined),
      settingsWith({ driver: ProviderDriverKind.make("pi") }),
    );
    yield* hydrate(implicit(), revision);
    assert.strictEqual(yield* liveInstance(registry), live);
    assert.equal((yield* open(live, "native/model"))._tag, "Success");
    assert.equal(pi.launches.length, 1);
  }).pipe(Effect.provide(layerOpenCodex(() => [])), Effect.scoped),
);

it.effect.each([
  { transition: "removed", next: {} },
  {
    transition: "replaced after a failed Home construction",
    next: { [instanceId]: piEntry({ modelRoute: "opencodex", opencodexBaseUrl: HOME }) },
  },
  {
    transition: "replaced by a driver without the Home route",
    next: { [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true } },
  },
])("refuses a retained background generation after its instance is $transition", ({ next }) =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    const pi = fakeDriver("pi");
    const codex = fakeDriver("codex");
    const { registry, hydrate } = yield* makeRegistry([pi.driver, codex.driver]);
    yield* hydrate({ [instanceId]: piEntry() }, state.revision());
    const retained = yield* liveInstance(registry);
    assert.equal((yield* generateTitle(retained))._tag, "Success");
    const revision = yield* state.committed(
      settingsWith(piEntry()),
      settingsWith(next[instanceId]),
    );
    yield* state.applied(revision);
    yield* hydrate(next, revision);
    assert.equal((yield* generateTitle(retained))._tag, "Failure");
    assert.equal((yield* open(retained, "native/model"))._tag, "Failure");
    assert.deepEqual(pi.requests, ["title:native/model"]);
  }).pipe(
    Effect.provide(layerOpenCodex(() => ["provider/model"], { exportFails: true })),
    Effect.scoped,
  ),
);

it.effect("refuses a runtime hydrated from a superseded snapshot and binds the newer one", () =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    const { driver, launches } = fakeDriver("pi");
    const retained = yield* create(driver, {}, state.revision());
    // Two commits land before the watcher hydrates the first of them.
    const first = yield* state.committed(
      settingsWith(undefined),
      settingsWith(piEntry({ launchArgs: "--a" })),
    );
    const second = yield* state.committed(
      settingsWith(piEntry({ launchArgs: "--a" })),
      settingsWith(piEntry({ launchArgs: "--b" })),
    );
    const delayed = yield* create(driver, { launchArgs: "--a" }, first).pipe(Effect.result);
    assert.equal(delayed._tag, "Failure");
    assert.equal(launches.length, 1);
    const current = yield* create(driver, { launchArgs: "--b" }, second);
    assert.equal((yield* open(retained, "native/model"))._tag, "Failure");
    assert.equal((yield* open(current, "native/model"))._tag, "Success");
  }).pipe(Effect.provide(layerOpenCodex(() => [])), Effect.scoped),
);

it.effect("rebuilds a reconnected Pi runtime with Home's current models and files together", () => {
  let models: ReadonlyArray<string> = ["provider/a", "provider/b"];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { driver, launches } = fakeDriver("pi");
    const routed = { modelRoute: "opencodex", opencodexBaseUrl: HOME };
    const before = yield* create(driver, { ...routed, opencodexRouteRevision: "approval-1" });
    // Home's catalog changes; the next approved connect records a new route revision.
    models = ["provider/b", "provider/c"];
    const after = yield* create(driver, { ...routed, opencodexRouteRevision: "approval-2" });
    const slugs = (instance: ProviderInstance) =>
      instance.snapshot.getSnapshot.pipe(
        Effect.map((snapshot) => snapshot.models.map(({ slug }) => slug)),
      );
    assert.deepEqual(yield* slugs(before), ["opencodex/provider/a", "opencodex/provider/b"]);
    assert.deepEqual(yield* slugs(after), ["opencodex/provider/b", "opencodex/provider/c"]);
    assert.equal((yield* open(after, "opencodex/provider/a"))._tag, "Failure");
    assert.equal((yield* open(after, "opencodex/provider/c"))._tag, "Success");
    assert.equal((yield* open(before, "opencodex/provider/b"))._tag, "Failure");
    const agentDir = launches[1]?.find(({ name }) => name === "PI_CODING_AGENT_DIR")?.value ?? "";
    const published = yield* fs.readFileString(path.join(agentDir, "models.json"));
    assert.include(published, "provider/c");
    assert.notInclude(published, "provider/a");
  }).pipe(Effect.provide(layerOpenCodex(() => models)), Effect.scoped);
});
