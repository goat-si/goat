import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FleetSettings,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Fallback from "./Fallback.ts";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const FAILED_AT = NOW - 60_000;
const LATER = "2026-10-20T05:00:00.000Z";
const codex = ProviderInstanceId.make("codex");
const claudeAgent = ProviderInstanceId.make("claudeAgent");
const opus = { instanceId: codex, model: "anthropic/claude-opus-5-5" };
const opus2 = { instanceId: codex, model: "anthropic2/claude-opus-5-5" };
const sol = { instanceId: codex, model: "gpt-6.1-sol" };
const claude = { instanceId: claudeAgent, model: "claude-opus-5-5" };
const threadId = ThreadId.make("thread:fleet");
const runId = RunId.make("run:2");
const selectId = (model: string) =>
  "fleet-fallback:thread:fleet:run:2:" +
  (model === claude.model ? "claudeAgent/" : "codex/") +
  model;

const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: threadId,
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: LATER,
    latestRunId: runId,
    providerInstanceId: codex,
    modelSelection: opus,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    snoozedUntil: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const run = (ordinal: number, status: string, modelSelection: typeof opus) => ({
  id: RunId.make("run:" + ordinal),
  rootNodeId: null,
  ordinal,
  status,
  startedAt: ordinal,
  completedAt: DateTime.makeUnsafe(FAILED_AT - (2 - ordinal) * 60_000),
  modelSelection,
});

interface World {
  stopped: boolean;
  shell: OrchestrationV2ThreadShell;
  runs: ReadonlyArray<ReturnType<typeof run>>;
  refuse: ReadonlySet<string>;
  disabledForProject: ReadonlySet<string>;
  readonly receipts: Map<string, "accepted" | "rejected">;
  readonly selects: Array<string>;
  readonly commands: Array<OrchestrationV2ServerCommand>;
}
const makeWorld = (overrides: Partial<World> = {}): World => ({
  stopped: false,
  shell: shell(),
  runs: [run(1, "completed", opus), run(2, "failed", opus)],
  refuse: new Set(),
  disabledForProject: new Set(),
  receipts: new Map(),
  selects: [],
  commands: [],
  ...overrides,
});

const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
  exhausted = false,
) =>
  ({
    instanceId,
    enabled: true,
    models: models.map((slug) => ({ slug, name: slug })),
    usageLimits: {
      checkedAt: "2026-10-19T23:00:00.000Z",
      windows: [
        {
          id: "w",
          kind: "weekly",
          label: "Weekly",
          usedPercent: exhausted ? 100 : 10,
          resetsAt: LATER,
        },
      ],
    },
  }) as unknown as ServerProvider;

const threadChain: FleetSettings = {
  fallbackChains: { claude: { steps: [opus, opus2, sol, claude], scope: "goals_and_threads" } },
};

const threadsLayer = (world: World) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.sync(() => world.shell),
    getThreadRecords: (() =>
      Effect.sync(() => ({
        runs: world.runs,
        providerSessions: [],
        turnItems: [
          ...(world.stopped ? [{ runId, type: "run_interrupt_request" }] : []),
          {
            id: "failure",
            runId,
            nodeId: null,
            type: "error",
            status: "failed",
            ordinal: 1,
            updatedAt: DateTime.makeUnsafe(FAILED_AT),
            failure: {
              class: world.shell.lastErrorClass,
              message: "Failed",
              ...(world.shell.usageLimitResetAt == null
                ? {}
                : { resetAt: world.shell.usageLimitResetAt }),
            },
          },
        ],
      }))) as never,
    receiptStatus: (commandId) => Effect.sync(() => world.receipts.get(commandId) ?? null),
    isProviderInstanceEnabledForProject: ({ instanceId }) =>
      Effect.sync(() => !world.disabledForProject.has(instanceId)),
    dispatch: (command) =>
      Effect.suspend(() => {
        const target =
          command.type === "thread.model-selection.set" || command.type === "provider.switch"
            ? command.modelSelection
            : undefined;
        if (target !== undefined) world.selects.push(command.commandId + " " + target.model);
        if (target !== undefined && world.refuse.has(target.model)) {
          world.receipts.set(command.commandId, "rejected");
          return Effect.die("selection refused");
        }
        world.receipts.set(command.commandId, "accepted");
        world.commands.push(command);
        if (target !== undefined) world.shell = { ...world.shell, modelSelection: target };
        return Effect.succeed({ sequence: world.commands.length } as never);
      }),
  });

const providersLayer = (claudeExhausted: boolean) =>
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([
      provider(codex, [opus.model, opus2.model, sol.model]),
      provider(claudeAgent, [claude.model], claudeExhausted),
    ]),
  });

const layer = (world: World, fleet: FleetSettings, claudeExhausted = false) =>
  Layer.mergeAll(Fallback.layer, Fallback.layerChains).pipe(
    Layer.provide(threadsLayer(world)),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest({ fleet })),
    Layer.provide(providersLayer(claudeExhausted)),
  );

const summary = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.map((command) =>
    command.type === "thread.notice.record"
      ? "notice: " + command.message
      : command.type === "thread.model-selection.set" || command.type === "provider.switch"
        ? command.type + " " + command.modelSelection.model
        : command.type,
  );

const continueOnce = Effect.flatMap(Fallback.Fallback, (fallback) =>
  fallback.continueThread(threadId),
);

const withClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(NOW).pipe(Effect.andThen(effect));

describe("Fallback.continueThread", () => {
  it.effect(
    "does not switch a successfully continued run again after restart or model changes",
    () => {
      const world = makeWorld();
      return withClock(
        Effect.gen(function* () {
          assert.isTrue(yield* continueOnce.pipe(Effect.provide(layer(world, threadChain))));
          const commands = [...world.commands];
          world.shell = shell();
          assert.isTrue(
            yield* continueOnce.pipe(
              Effect.provide(
                layer(world, {
                  fallbackChains: {
                    replacement: { steps: [opus, sol], scope: "goals_and_threads" },
                  },
                }),
              ),
            ),
          );
          assert.deepEqual(world.commands, commands);
        }),
      );
    },
  );

  it.effect("does not continue a run reached by Stop", () => {
    const world = makeWorld({ stopped: true });
    return withClock(
      continueOnce.pipe(
        Effect.map((switched) => {
          assert.isFalse(switched);
          assert.deepEqual(world.commands, []);
        }),
        Effect.provide(layer(world, threadChain)),
      ),
    );
  });

  it.effect.each(["provider_error", "transport_error", "unknown", "permission_error"] as const)(
    "only switches explicitly configured failure classes: %s",
    (failure) =>
      withClock(
        Effect.gen(function* () {
          for (const on of [undefined, ["provider_error", "transport_error"] as const]) {
            const world = makeWorld({
              shell: shell({ lastErrorClass: failure, usageLimitResetAt: null }),
            });
            const switched = yield* continueOnce.pipe(
              Effect.provide(
                layer(world, {
                  fallbackChains: {
                    selected: {
                      steps: [opus, opus2],
                      scope: "goals_and_threads",
                      ...(on ? { on } : {}),
                    },
                  },
                }),
              ),
            );
            const expected =
              on !== undefined && (failure === "provider_error" || failure === "transport_error");
            assert.equal(switched, expected);
            assert.equal(world.selects.length, expected ? 1 : 0);
            assert.equal(
              world.commands.filter((command) => command.type === "message.dispatch").length,
              expected ? 1 : 0,
            );
          }
        }),
      ),
  );
  it.effect(
    "switches a usage-limited thread to the next step with a notice and a continuation",
    () => {
      const world = makeWorld();
      return withClock(
        Effect.gen(function* () {
          const fallback = yield* Fallback.Fallback;
          assert.isTrue(yield* fallback.continueThread(threadId));
          assert.deepStrictEqual(summary(world.commands), [
            "thread.model-selection.set anthropic2/claude-opus-5-5",
            "notice: Switched to codex/anthropic2/claude-opus-5-5 after usage_limit on codex/anthropic/claude-opus-5-5; that limit resets at " +
              LATER +
              " (fallback chain claude).",
            "message.dispatch",
          ]);
          assert.deepStrictEqual(
            world.commands.map((command) => command.commandId),
            [
              selectId(opus2.model),
              "fleet-fallback-notice:switch:run:2",
              "fleet-fallback:thread:fleet:run:2:continue",
            ],
          );
          // The failed model cools down from when it failed.
          assert.deepStrictEqual(
            (yield* fallback.cooldowns).map((entry) => [entry.model, entry.failure, entry.until]),
            [[opus.model, "usage_limit", "2026-10-20T00:14:00.000Z"]],
          );
        }).pipe(Effect.provide(layer(world, threadChain))),
      );
    },
  );

  it.effect("moves a usage limit that has no reset time", () => {
    const world = makeWorld({ shell: shell({ usageLimitResetAt: null }) });
    return withClock(
      continueOnce.pipe(
        Effect.map((switched) => {
          assert.isTrue(switched);
          assert.strictEqual(
            summary(world.commands)[1],
            "notice: Switched to codex/anthropic2/claude-opus-5-5 after usage_limit on codex/anthropic/claude-opus-5-5 (fallback chain claude).",
          );
        }),
        Effect.provide(layer(world, threadChain)),
      ),
    );
  });

  it.effect("leaves a snoozed thread asleep", () => {
    const world = makeWorld({
      shell: shell({ snoozedUntil: DateTime.makeUnsafe(NOW + 3_600_000) }),
    });
    return withClock(
      continueOnce.pipe(
        Effect.map((switched) => {
          assert.isFalse(switched);
          assert.deepStrictEqual(world.commands, []);
        }),
        Effect.provide(layer(world, threadChain)),
      ),
    );
  });

  it.effect(
    "finishes a hop that landed before a long outage, even if that account ran out since",
    () => {
      const world = makeWorld({
        shell: shell({ modelSelection: opus2 }),
        receipts: new Map([
          [selectId(opus2.model), "rejected"],
          [selectId(opus2.model) + ":retry:1", "accepted"],
        ]),
      });
      return TestClock.setTime(NOW + 86_400_000).pipe(
        Effect.andThen(continueOnce),
        Effect.map((switched) => {
          assert.isTrue(switched);
          assert.deepStrictEqual(
            world.commands.map((command) => command.commandId),
            ["fleet-fallback-notice:switch:run:2", "fleet-fallback:thread:fleet:run:2:continue"],
          );
        }),
        Effect.provide(layer(world, threadChain)),
      );
    },
  );

  it.effect("leaves a model the user picked by hand, even one a rejected attempt named", () => {
    const world = makeWorld({
      shell: shell({ modelSelection: opus2 }),
      receipts: new Map([[selectId(opus2.model), "rejected"]]),
    });
    return withClock(
      continueOnce.pipe(
        Effect.map((switched) => {
          assert.isFalse(switched);
          assert.deepStrictEqual(world.commands, []);
        }),
        Effect.provide(layer(world, threadChain)),
      ),
    );
  });

  it.effect("follows the failed tail and crosses to another driver with a provider switch", () => {
    const world = makeWorld({
      shell: shell({ modelSelection: sol }),
      runs: [run(1, "failed", opus), run(2, "failed", sol)],
    });
    return withClock(
      continueOnce.pipe(
        Effect.map(() =>
          assert.strictEqual(summary(world.commands)[0], "provider.switch claude-opus-5-5"),
        ),
        Effect.provide(layer(world, threadChain)),
      ),
    );
  });

  it.effect("moves past a refused step in the same decision, even with no cooldown", () => {
    const world = makeWorld({ refuse: new Set([opus2.model]) });
    return withClock(
      continueOnce.pipe(
        Effect.map((switched) => {
          assert.isTrue(switched);
          assert.deepStrictEqual(world.selects, [
            selectId(opus2.model) + " " + opus2.model,
            selectId(sol.model) + " " + sol.model,
          ]);
        }),
        Effect.provide(
          layer(world, {
            fallbackChains: {
              claude: {
                steps: [opus, opus2, sol, claude],
                scope: "goals_and_threads",
                cooldownMs: 0,
              },
            },
          }),
        ),
      ),
    );
  });

  it.effect(
    "retries a refused step under the next attempt id instead of replaying the refusal",
    () => {
      const world = makeWorld({
        refuse: new Set([opus2.model]),
        receipts: new Map([[selectId(opus2.model), "rejected"]]),
      });
      return withClock(
        continueOnce.pipe(
          Effect.map(() =>
            assert.strictEqual(world.selects[0], selectId(opus2.model) + ":retry:1 " + opus2.model),
          ),
          Effect.provide(
            layer(world, {
              fallbackChains: {
                claude: { steps: [opus, opus2], scope: "goals_and_threads", cooldownMs: 0 },
              },
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "waits without pushing the cooldown out on every sweep, telling the thread once",
    () => {
      const world = makeWorld();
      return withClock(
        Effect.gen(function* () {
          const fallback = yield* Fallback.Fallback;
          assert.isFalse(yield* fallback.continueThread(threadId));
          yield* TestClock.adjust("5 minutes");
          assert.isFalse(yield* fallback.continueThread(threadId));
          assert.deepStrictEqual(summary(world.commands), [
            "notice: Fallback chain short did not switch models: no step is available (claudeAgent/claude-opus-5-5 is at its usage limit).",
          ]);
          assert.deepStrictEqual(
            (yield* fallback.cooldowns).map((entry) => entry.until),
            ["2026-10-20T00:14:00.000Z"],
          );
        }).pipe(
          Effect.provide(
            layer(
              world,
              { fallbackChains: { short: { steps: [opus, claude], scope: "goals_and_threads" } } },
              true,
            ),
          ),
        ),
      );
    },
  );

  it.effect("skips a step whose instance this project disabled without cooling it down", () => {
    const world = makeWorld({
      shell: shell({ modelSelection: sol }),
      runs: [run(1, "failed", opus), run(2, "failed", sol)],
      disabledForProject: new Set(["claudeAgent"]),
    });
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        assert.isTrue(yield* fallback.continueThread(threadId));
        assert.strictEqual(
          summary(world.commands)[0],
          "thread.model-selection.set anthropic2/claude-opus-5-5",
        );
        assert.notInclude(
          (yield* fallback.cooldowns).map((entry) => entry.model),
          claude.model,
        );
      }).pipe(Effect.provide(layer(world, threadChain))),
    );
  });

  it.effect("leaves goal threads, goal-only chains and unchained threads alone", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        assert.isFalse(
          yield* continueOnce.pipe(
            Effect.provideService(Fallback.GoalThreadOwnership, {
              isGoalThread: () => Effect.succeed(true),
            }),
            Effect.provide(layer(world, threadChain)),
          ),
        );
        assert.isFalse(
          yield* continueOnce.pipe(
            Effect.provide(layer(world, { fallbackChains: { claude: { steps: [opus, opus2] } } })),
          ),
        );
        assert.isFalse(yield* continueOnce.pipe(Effect.provide(layer(world, {}))));
        assert.deepStrictEqual(world.commands, []);
      }),
    );
  });
});

describe("Fallback.next", () => {
  it.effect("walks the named or default chain, honours cooldowns on remote hosts too", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        const fallback = yield* Fallback.Fallback;
        const base = {
          selection: opus,
          failure: "usage_limit" as const,
          tried: [],
          threadId: null,
        };
        assert.deepStrictEqual(yield* fallback.next({ ...base, chain: null, host: null }), {
          _tag: "SwitchInThread",
          selection: opus2,
          hop: 1,
        });
        yield* fallback.reportFailure(opus2, "usage_limit");
        assert.deepStrictEqual(yield* fallback.next({ ...base, chain: "claude", host: null }), {
          _tag: "SwitchInThread",
          selection: sol,
          hop: 1,
        });
        assert.deepStrictEqual(
          yield* fallback.next({ ...base, chain: "claude", host: "lidge-ai" }),
          {
            _tag: "SwitchInThread",
            selection: sol,
            hop: 1,
          },
        );
        assert.deepStrictEqual(yield* fallback.next({ ...base, chain: "missing", host: null }), {
          _tag: "Exhausted",
          reason: "fallback chain missing is not configured",
        });
      }).pipe(Effect.provide(layer(world, { ...threadChain, defaultFallbackChain: "claude" }))),
    );
  });
});

/** Settings whose first chain write loses the race to another writer that commits first. */
const racingSettings = (fleet: FleetSettings) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      let raced = false;
      return ServerSettings.ServerSettingsService.of({
        ...base,
        updateSettingsWith: (patchFor, authorizeAtCommit) =>
          Effect.gen(function* () {
            if (!raced) {
              raced = true;
              const current = (yield* base.getSettings).fleet;
              yield* base.updateSettings({
                fleet: {
                  fallbackChains: { ...current.fallbackChains, theirs: { steps: [sol] } },
                  defaultFallbackChain: "theirs",
                },
              });
            }
            return yield* base.updateSettingsWith(patchFor, authorizeAtCommit);
          }),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest({ fleet })));

describe("FallbackChains", () => {
  it.effect("validates instances, warns on unlisted models, and keeps the default in step", () => {
    const world = makeWorld();
    return withClock(
      Effect.gen(function* () {
        const chains = yield* Fallback.FallbackChains;
        const refused = yield* Effect.flip(
          chains.set({
            id: "x",
            chain: { steps: [{ instanceId: ProviderInstanceId.make("nope"), model: "m" }] },
          }),
        );
        assert.include(refused.message, "Provider instance nope is not configured here");
        const saved = yield* chains.set({
          id: "claude",
          chain: { steps: [opus, { instanceId: codex, model: "made-up" }] },
          makeDefault: true,
        });
        assert.deepStrictEqual(saved.warnings, ["codex does not list model made-up."]);
        assert.strictEqual(saved.defaultFallbackChain, "claude");
        yield* chains.set({ id: "other", chain: { steps: [sol] } });
        const removed = yield* chains.set({ id: "claude", chain: null });
        assert.deepStrictEqual(Object.keys(removed.chains), ["other"]);
        assert.isNull(removed.defaultFallbackChain);
      }).pipe(Effect.provide(layer(world, {}))),
    );
  });

  it.effect("keeps a chain and default another writer saved while this edit was in flight", () =>
    withClock(
      Effect.gen(function* () {
        const chains = yield* Fallback.FallbackChains;
        const saved = yield* chains.set({ id: "mine", chain: { steps: [opus] } });
        assert.deepStrictEqual(Object.keys(saved.chains).toSorted(), ["mine", "theirs"]);
        assert.strictEqual(saved.defaultFallbackChain, "theirs");
      }).pipe(
        Effect.provide(
          Fallback.layerChains.pipe(
            Layer.provide(racingSettings({})),
            Layer.provide(providersLayer(false)),
          ),
        ),
      ),
    ),
  );
});
