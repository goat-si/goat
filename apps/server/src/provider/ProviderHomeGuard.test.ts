import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ServerSettings,
  type TextGenerationError,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Routes from "./CodexRouteService.ts";
import { guardProviderHomeInstance } from "./ProviderHomeGuard.ts";
import type { ProviderHomeRuntime } from "./ProviderHomeRuntime.ts";

const HOME_MODEL = "opencodex/provider/model";
const home: ProviderHomeRuntime = {
  baseUrl: "http://127.0.0.1:10100/v1",
  environment: [],
  models: [{ slug: HOME_MODEL, name: "Home model", isCustom: true, capabilities: null }],
  allowedModels: new Set([HOME_MODEL]),
};
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const TEXT_OPERATIONS = [
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateReviewGuide",
  "generateChannelReception",
  "resolveMemoryConflict",
  "generateMemorySummary",
] as const;
type Selected = { readonly modelSelection: { readonly model: string } };
type TextOperation = (input: Selected) => Effect.Effect<unknown, TextGenerationError>;
const selected = <A>(model: string) => ({ modelSelection: { model } }) as unknown as A;

/** A provider at its process boundary: it records every request that reaches it. */
const fakeInstance = (
  id: string,
  driver: string,
  options: { readonly title?: Effect.Effect<void> } = {},
) => {
  const seen: Array<string> = [];
  const record = (entry: string) => Effect.sync(() => void seen.push(entry));
  const runtime = {
    ensureThread: (input: Selected) => record(`ensure:${input.modelSelection.model}`),
    resumeThread: () => record("resume"),
    forkThread: (input: Partial<Selected>) =>
      record(`fork:${input.modelSelection?.model ?? "none"}`),
    startTurn: (input: Selected) => record(`turn:${input.modelSelection.model}`),
    compactThread: (input: Selected) => record(`compact:${input.modelSelection.model}`),
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  const text = Object.fromEntries(
    TEXT_OPERATIONS.map((operation) => [
      operation,
      (input: Selected) =>
        (operation === "generateThreadTitle" && options.title ? options.title : Effect.void).pipe(
          Effect.andThen(record(`${operation}:${input.modelSelection.model}`)),
          Effect.as({}),
        ),
    ]),
  );
  const snapshot = decodeProvider({
    instanceId: id,
    driver,
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    models: [{ slug: "native/model", name: "Native", isCustom: false, capabilities: null }],
  });
  const instance = {
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make(driver),
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.make(snapshot),
    },
    orchestrationAdapter: {
      openSession: (input: Selected) =>
        record(`open:${input.modelSelection.model}`).pipe(Effect.as(runtime)),
    },
    textGeneration: text,
  } as unknown as ProviderInstance;
  return { instance, seen };
};
const settingsWith = (
  instances: Readonly<Record<string, { readonly driver: string; readonly modelRoute: string }>>,
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    Object.entries(instances).map(([id, { driver, modelRoute }]) => [
      id,
      { driver: ProviderDriverKind.make(driver), config: { modelRoute } },
    ]),
  ),
});
const open = (instance: ProviderInstance, model: string) =>
  Effect.scoped(
    instance.orchestrationAdapter.openSession(
      selected<ProviderAdapter.ProviderAdapterV2OpenSessionInput>(model),
    ),
  );

it.effect("refuses a default or foreign model before a Home session opens or a turn starts", () =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    const { instance, seen } = fakeInstance("pi-home", "pi");
    const guarded = guardProviderHomeInstance(
      instance,
      home,
      state,
      state.generation(instance.instanceId),
    );
    const turn = (model: string) => selected<ProviderAdapter.ProviderAdapterV2TurnInput>(model);
    for (const model of ["default", "other/model"]) {
      const refused = yield* open(guarded, model).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
    }
    const runtime = yield* open(guarded, HOME_MODEL);
    for (const attempt of [
      runtime.startTurn(turn("default")),
      runtime.ensureThread(
        selected<ProviderAdapter.ProviderAdapterV2EnsureThreadInput>("other/model"),
      ),
      runtime.forkThread(selected<ProviderAdapter.ProviderAdapterV2ForkThreadInput>("other/model")),
      runtime.compactThread?.(turn("other/model")) ?? Effect.die("compactThread was dropped"),
    ]) {
      const result = yield* attempt.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(result.failure._tag, "ProviderAdapterProtocolError");
    }
    yield* runtime.startTurn(turn(HOME_MODEL));
    yield* runtime.forkThread({} as ProviderAdapter.ProviderAdapterV2ForkThreadInput);
    assert.deepEqual(seen, [`open:${HOME_MODEL}`, `turn:${HOME_MODEL}`, "fork:none"]);
  }).pipe(Effect.provide(Routes.layerState)),
);

it.effect.each([
  { route: "a Home", runtime: home, model: HOME_MODEL },
  { route: "the default", runtime: undefined, model: "native/model" },
])("keeps a route change waiting while background generation runs on $route route", (row) =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { instance } = fakeInstance("pi-home", "pi", {
      title: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    const guarded = guardProviderHomeInstance(
      instance,
      row.runtime,
      state,
      state.generation(instance.instanceId),
    );
    const current = settingsWith({ "pi-home": { driver: "pi", modelRoute: "default" } });
    const next = settingsWith({ "pi-home": { driver: "pi", modelRoute: "opencodex" } });
    const generation = yield* guarded.textGeneration
      .generateThreadTitle(selected(row.model))
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const busy = yield* state.validate(current, next).pipe(Effect.result);
    assert.equal(busy._tag, "Failure");
    if (busy._tag === "Failure") assert.equal(busy.failure.code, "provider_instance_busy");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(generation);
    yield* state.validate(current, next);
  }).pipe(Effect.provide(Routes.layerState)),
);

it.effect("refuses foreign models for every text operation and routed OpenCode memory work", () =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    for (const driver of ["pi", "opencode"]) {
      const { instance, seen } = fakeInstance(`${driver}-home`, driver);
      const guarded = guardProviderHomeInstance(
        instance,
        home,
        state,
        state.generation(instance.instanceId),
      );
      const operations = guarded.textGeneration as unknown as Record<string, TextOperation>;
      for (const operation of TEXT_OPERATIONS) {
        const result = yield* operations[operation]!(selected("other/model")).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
      for (const operation of ["resolveMemoryConflict", "generateMemorySummary"]) {
        const result = yield* operations[operation]!(selected(HOME_MODEL)).pipe(Effect.result);
        assert.equal(result._tag, driver === "opencode" ? "Failure" : "Success");
      }
      assert.deepEqual(
        seen,
        driver === "opencode"
          ? []
          : [`resolveMemoryConflict:${HOME_MODEL}`, `generateMemorySummary:${HOME_MODEL}`],
      );
    }
  }).pipe(Effect.provide(Routes.layerState)),
);

it.effect(
  "rejects a retained runtime after its instance is reconfigured without affecting another",
  () =>
    Effect.gen(function* () {
      const state = yield* Routes.CodexRouteState;
      const guard = (id: string) => {
        const { instance, seen } = fakeInstance(id, "pi");
        return {
          seen,
          instance: guardProviderHomeInstance(
            instance,
            home,
            state,
            state.generation(instance.instanceId),
          ),
        };
      };
      const retained = guard("pi-a");
      const unrelated = guard("pi-b");
      yield* state.committed(
        settingsWith({
          "pi-a": { driver: "pi", modelRoute: "default" },
          "pi-b": { driver: "pi", modelRoute: "default" },
        }),
        settingsWith({
          "pi-a": { driver: "pi", modelRoute: "opencodex" },
          "pi-b": { driver: "pi", modelRoute: "default" },
        }),
      );
      const stale = yield* open(retained.instance, HOME_MODEL).pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      assert.deepEqual(retained.seen, []);
      yield* open(unrelated.instance, HOME_MODEL);
      const recreated = guard("pi-a");
      yield* open(recreated.instance, HOME_MODEL);
      assert.deepEqual(recreated.seen, [`open:${HOME_MODEL}`]);
    }).pipe(Effect.provide(Routes.layerState)),
);

it.effect("reports the Home endpoint and models only from a routed runtime", () =>
  Effect.gen(function* () {
    const state = yield* Routes.CodexRouteState;
    const routedSource = fakeInstance("pi-home", "pi").instance;
    const routed = guardProviderHomeInstance(
      routedSource,
      home,
      state,
      state.generation(routedSource.instanceId),
    );
    const plain = guardProviderHomeInstance(
      routedSource,
      undefined,
      state,
      state.generation(routedSource.instanceId),
    );
    for (const snapshot of [
      yield* routed.snapshot.getSnapshot,
      yield* routed.snapshot.refresh,
      ...(yield* Stream.runCollect(routed.snapshot.streamChanges)),
    ]) {
      assert.deepEqual(snapshot.homeRoute, {
        modelRoute: "opencodex",
        effectiveBaseUrl: home.baseUrl,
      });
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        [HOME_MODEL],
      );
    }
    const original = yield* plain.snapshot.getSnapshot;
    assert.isUndefined(original.homeRoute);
    assert.deepEqual(
      original.models.map((model) => model.slug),
      ["native/model"],
    );
  }).pipe(Effect.provide(Routes.layerState)),
);
