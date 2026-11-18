import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Hold from "./MemoryGenerationHold.ts";
import * as MemorySettings from "./MemorySettingsService.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Worker from "./MemoryWorker.ts";
import { live, now, seed } from "./MemoryWorker.testkit.ts";

const codex = { instanceId: M.ProviderInstanceId.make("codex"), model: "gpt-6-luna" };
const claude = { instanceId: M.ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
const api = M.ProviderInstanceId.make("memory-api-writer");
const muse = { instanceId: M.ProviderInstanceId.make("muse"), model: "muse" };
const pi = { instanceId: M.ProviderInstanceId.make("pi"), model: "demo/model" };
const ready = (selection: M.ModelSelection): M.ServerProvider => ({
  instanceId: selection.instanceId,
  driver: M.ProviderDriverKind.make(selection.instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

it.effect.each(["signed out", "exhausted", "signed out on a dedicated coding model"] as const)(
  "admits and retries summaries using the ready fallback when Codex is %s",
  (unavailable) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      const unavailableCodex: M.ServerProvider =
        unavailable !== "exhausted"
          ? { ...ready(codex), auth: { status: "unauthenticated" } }
          : {
              ...ready(codex),
              usageLimits: {
                checkedAt: now,
                windows: [
                  {
                    id: "weekly",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: 100,
                    exhausted: true,
                  },
                ],
              },
            };
      const snapshots = yield* Ref.make<ReadonlyArray<M.ServerProvider>>([
        unavailableCodex,
        ready(claude),
      ]);
      const inputs: Array<M.MemoryModelSelection> = [];
      const registry = Layer.mock(ProviderRegistry)({ getProviders: Ref.get(snapshots) });
      const runtime = live(
        () => (inputs.length === 1 ? "synthetic failure" : undefined),
        (input) => inputs.push(input.modelSelection),
      ).pipe(Layer.provide(Hold.layer.pipe(Layer.provide(registry))));
      const withStatus = MemorySettings.layer.pipe(
        Layer.provide(Layer.mock(Sync.MemorySyncService)({})),
        Layer.provideMerge(runtime),
        Layer.provide(registry),
      );
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({
          memoryModelSelection:
            unavailable === "signed out on a dedicated coding model" ? codex : null,
          textGenerationModelSelection: { instanceId: api, model: "writer" },
          textGenerators: {
            [api]: {
              kind: "openaiCompatible",
              baseUrl: "https://model.example/v1",
              apiKey: "",
              enabled: true,
            },
          },
        });
        yield* seed;
        const worker = yield* Worker.MemoryWorker;
        const status = yield* MemorySettings.MemorySettingsService;
        yield* worker.sweepDue();
        assert.deepStrictEqual(inputs, [claude]);
        assert.deepStrictEqual((yield* status.get(Effect.void)).model.selection, claude);

        yield* Ref.set(snapshots, [ready(codex), ready(claude)]);
        yield* TestClock.adjust(Worker.memoryRetryDelay(1));
        yield* worker.sweepDue();
        assert.deepStrictEqual(inputs, [claude, codex]);
        assert.deepStrictEqual((yield* status.get(Effect.void)).model.selection, codex);
      }).pipe(Effect.provide(withStatus));
    }),
);

it.effect.each(["primary", "fallback"] as const)(
  "uses a provider with the summary operation when Muse is the %s candidate",
  (candidate) =>
    Effect.gen(function* () {
      const withoutMemory = {
        ...ready(muse),
        memoryGeneration: { summary: false, conflict: false },
      };
      const withMemory = { ...ready(pi), memoryGeneration: { summary: true, conflict: true } };
      const registry = Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([withoutMemory, withMemory]),
      });
      const inputs: Array<M.MemoryModelSelection> = [];
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({
          providerInstances: {
            [muse.instanceId]: { driver: withoutMemory.driver, enabled: true },
            [pi.instanceId]: { driver: withMemory.driver, enabled: true },
          },
          textGenerationModelSelection: candidate === "primary" ? pi : codex,
          memoryModelSelection: candidate === "primary" ? muse : null,
        });
        yield* seed;
        const worker = yield* Worker.MemoryWorker;
        yield* worker.sweepDue();
        assert.deepStrictEqual(inputs, [pi]);
      }).pipe(
        Effect.provide(
          live(
            () => undefined,
            (input) => inputs.push(input.modelSelection),
          ).pipe(Layer.provide(Hold.layer.pipe(Layer.provide(registry)))),
        ),
      );
    }),
);
