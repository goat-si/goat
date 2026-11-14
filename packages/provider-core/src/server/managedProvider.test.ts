import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ServerProvider,
} from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import * as Cache from "effect/Cache";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const fastModeCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

interface TestSettings {
  readonly enabled: boolean;
}

const maintenanceCapabilities = {
  provider: ProviderDriverKind.make("codex"),
  packageName: "@openai/codex",
  update: {
    command: "npm install -g @openai/codex@latest",

    executable: "npm",

    args: ["install", "-g", "@openai/codex@latest"],

    lockKey: "npm-global",
  },
} as const;

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const refreshedSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const enrichedSnapshot: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:02.000Z",
  models: [
    {
      slug: "composer-2",
      name: "Composer 2",
      isCustom: false,
      capabilities: fastModeCapabilities,
    },
  ],
};

const refreshedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshot,
  checkedAt: "2026-04-10T00:00:03.000Z",
  message: "Refreshed provider availability again.",
};

function layerProviderHost(input: {
  readonly runBackgroundWork: boolean;
  readonly settings?: Pick<ProviderHost.ProviderHost["Service"], "settings">["settings"];
}) {
  return Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: input.settings ?? {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(input.runBackgroundWork),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  );
}

const layerAlwaysRunTest = layerProviderHost({ runBackgroundWork: true });

const enrichedSnapshotSecond: ServerProvider = {
  ...refreshedSnapshotSecond,
  checkedAt: "2026-04-10T00:00:04.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    },
  ],
};

describe("makeManagedServerProvider", () => {
  it.effect("invalidates cached usage and queues one refresh behind an in-flight refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const cache = yield* Cache.makeWith(
          () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(calls, (count) => count + 1);
              if (count === 2) {
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
              }
              return {
                ...refreshedSnapshot,
                usageLimits: {
                  checkedAt: refreshedSnapshot.checkedAt,
                  windows: [
                    {
                      id: "five_hour",
                      kind: "session",
                      label: "Session",
                      usedPercent: count === 1 ? 20 : 100,
                    },
                  ],
                },
              } satisfies ServerProvider;
            }),
          { capacity: 1, timeToLive: () => "5 minutes" },
        );
        const warmed = yield* Cache.get(cache, "claude");
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.die("usage refresh must not resolve maintenance"),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(warmed),
          checkProvider: Cache.get(cache, "claude"),
          invalidateUsageCache: Cache.invalidateAll(cache),
          refreshOnInterval: false,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        assert.strictEqual(yield* Ref.get(calls), 1);
        const refresh = yield* provider.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(probeStarted);
        const queued = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* provider.refreshUsage!;
        assert.strictEqual(yield* Ref.get(calls), 2);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 20);
        yield* Deferred.succeed(releaseProbe, undefined);
        yield* Fiber.join(refresh);
        yield* Fiber.join(queued);
        assert.strictEqual(yield* Ref.get(calls), 3);
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 100);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
  it.effect("keeps the waiting usage refresh's claim when the running one is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const usageProbeStarted = yield* Deferred.make<void>();
        const statusProbeStarted = yield* Deferred.make<void>();
        const releaseStatusProbe = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(calls, (count) => count + 1);
            if (count === 2) {
              yield* Deferred.succeed(usageProbeStarted, undefined);
              return yield* Effect.never;
            }
            if (count === 3) {
              yield* Deferred.succeed(statusProbeStarted, undefined);
              yield* Deferred.await(releaseStatusProbe);
            }
            return {
              ...refreshedSnapshot,
              usageLimits: { checkedAt: refreshedSnapshot.checkedAt, windows: [] },
            } satisfies ServerProvider;
          }),
          refreshOnInterval: false,
        });
        yield* provider.streamChanges.pipe(Stream.take(1), Stream.runDrain);
        const running = yield* provider.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(usageProbeStarted);
        const status = yield* provider.refresh.pipe(Effect.forkChild({ startImmediately: true }));
        const waiting = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(running);
        yield* Deferred.await(statusProbeStarted);
        const extra = yield* provider.refreshUsage!.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseStatusProbe, undefined);
        yield* Fiber.join(status);
        yield* Fiber.join(waiting);
        yield* Fiber.join(extra);
        assert.strictEqual(yield* Ref.get(calls), 4);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
  it.effect(
    "runs the initial provider check in the background and streams the refreshed snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const checkCalls = yield* Ref.make(0);
          const releaseCheck = yield* Deferred.make<void>();
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.update(checkCalls, (count) => count + 1).pipe(
              Effect.flatMap(() => Deferred.await(releaseCheck)),
              Effect.as(refreshedSnapshot),
            ),
            refreshInterval: "1 hour",
          });

          const initial = yield* provider.getSnapshot;
          assert.deepStrictEqual(initial, initialSnapshot);

          const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(checkCalls), 1);

          yield* Deferred.succeed(releaseCheck, undefined);

          const updates = Array.from(yield* Fiber.join(updatesFiber));
          const latest = yield* provider.getSnapshot;

          assert.deepStrictEqual(updates, [refreshedSnapshot]);
          assert.deepStrictEqual(latest, refreshedSnapshot);
          assert.strictEqual(yield* Ref.get(checkCalls), 1);
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("skips periodic provider refreshes without foreground provider-status demand", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const initialCheckDone = yield* Deferred.make<void>();
        yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: () => true,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(initialCheckDone, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.as(refreshedSnapshot),
          ),
          refreshInterval: "1 second",
        });

        yield* Deferred.await(initialCheckDone);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        assert.strictEqual(yield* Ref.get(checkCalls), 1);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(layerProviderHost({ runBackgroundWork: false }), TestClock.layer()),
      ),
    ),
  );

  it.effect("stops periodic recovery checks once the snapshot is ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const failedSnapshot = { ...refreshedSnapshot, status: "error" as const };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          refreshOnInterval: (snapshot) => snapshot.status === "error",
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseInitialCheck).pipe(
            Effect.andThen(Ref.updateAndGet(checkCalls, (count) => count + 1)),
            Effect.map((count) => (count === 1 ? failedSnapshot : refreshedSnapshot)),
          ),
          refreshInterval: "1 second",
        });
        const updates = yield* provider.streamChanges.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* TestClock.adjust("1 second");

        assert.deepStrictEqual(Array.from(yield* Fiber.join(updates)), [
          failedSnapshot,
          refreshedSnapshot,
        ]);
        yield* TestClock.adjust("3 seconds");
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(layerAlwaysRunTest, TestClock.layer()))),
  );

  it.effect("reruns the provider check when streamed settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: true });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const releaseSettingsCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : Deferred.await(releaseSettingsCheck).pipe(Effect.as(refreshedSnapshotSecond)),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseInitialCheck, undefined);
        yield* Ref.set(settingsRef, { enabled: false });
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.succeed(releaseSettingsCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(latest, refreshedSnapshotSecond);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps consuming settings changes after a provider check fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const releaseInitialCheck = yield* Deferred.make<void>();
        const thirdCheckStarted = yield* Deferred.make<void>();
        const releaseRecoveredCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(releaseInitialCheck).pipe(Effect.as(refreshedSnapshot))
                : count === 2
                  ? Effect.fail(
                      new ServerSettingsError({
                        settingsPath: "/t3/userdata/settings.json",
                        operation: "read-file",
                      }),
                    )
                  : Deferred.succeed(thirdCheckStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseRecoveredCheck)),
                      Effect.as(refreshedSnapshotSecond),
                    ),
            ),
          ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);

        // The first change fails its provider check; the failed application never
        // advances the stored settings, so the same change still differs next time.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        // The subscription must survive that failure and retry on the next change;
        // on main the dead consumer never starts the third check and this times out.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Deferred.await(thirdCheckStarted);
        assert.strictEqual(yield* Ref.get(checkCalls), 3);
        yield* Deferred.succeed(releaseRecoveredCheck, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(updates, [refreshedSnapshot, refreshedSnapshotSecond]);
        assert.deepStrictEqual(yield* provider.getSnapshot, refreshedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("streams supplemental snapshot updates after the base provider check completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(releaseCheck, undefined);

        yield* Deferred.succeed(releaseEnrichment, undefined);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [refreshedSnapshot, enrichedSnapshot]);
        assert.deepStrictEqual(latest, enrichedSnapshot);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("ignores stale enrichment callbacks after a newer refresh advances generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publishCallbacks: Array<(snapshot: ServerProvider) => Effect.Effect<void>> = [];
        const refreshCount = yield* Ref.make(0);
        const firstCallbackReady = yield* Deferred.make<void>();
        const secondCallbackReady = yield* Deferred.make<void>();
        const allowFirstRefresh = yield* Deferred.make<void>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.await(allowFirstRefresh).pipe(Effect.as(refreshedSnapshot))
                : Effect.succeed(refreshedSnapshotSecond),
            ),
          ),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              publishCallbacks.push(publishSnapshot);
              if (publishCallbacks.length === 1) {
                yield* Deferred.succeed(firstCallbackReady, undefined).pipe(Effect.ignore);
              } else if (publishCallbacks.length === 2) {
                yield* Deferred.succeed(secondCallbackReady, undefined).pipe(Effect.ignore);
              }
            }),
          refreshInterval: "1 hour",
        });

        const updatesFiber = yield* Stream.take(provider.streamChanges, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Deferred.succeed(allowFirstRefresh, undefined);
        yield* Deferred.await(firstCallbackReady);

        yield* provider.refresh;
        yield* Deferred.await(secondCallbackReady);

        yield* publishCallbacks[0]!(enrichedSnapshot);
        yield* publishCallbacks[1]!(enrichedSnapshotSecond);

        const updates = Array.from(yield* Fiber.join(updatesFiber));
        const latest = yield* provider.getSnapshot;

        assert.deepStrictEqual(updates, [
          refreshedSnapshot,
          refreshedSnapshotSecond,
          enrichedSnapshotSecond,
        ]);
        assert.deepStrictEqual(latest, enrichedSnapshotSecond);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("applies runtime usage updates onto the published snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed({
            ...refreshedSnapshot,
            usageLimits: {
              checkedAt: "2026-04-10T00:00:01.000Z",
              windows: [
                { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 20,
                  resetsAt: "2026-04-17T00:00:00.000Z",
                },
              ],
            },
          } satisfies ServerProvider),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const updatesFiber = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 25 }],
        });
        yield* provider.applyUsageLimits({ checkedAt: "2026-04-10T00:06:00.000Z", windows: [] });

        const [update] = Array.from(yield* Fiber.join(updatesFiber));
        assert.deepStrictEqual(update?.usageLimits, {
          checkedAt: "2026-04-10T00:05:00.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 25,
              resetsAt: "2026-04-17T00:00:00.000Z",
            },
          ],
        });
        assert.deepStrictEqual(yield* provider.getSnapshot, update);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps live usage windows across a failed probe and a stale enrichment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseEnrichment = yield* Deferred.make<void>();
        const refreshCount = yield* Ref.make(0);
        const probedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
        } as const;
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.updateAndGet(refreshCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    ...refreshedSnapshot,
                    auth: { ...refreshedSnapshot.auth, workspaceId: "ws-a" },
                    usageLimits: probedLimits,
                  }
                : {
                    ...refreshedSnapshotSecond,
                    ...(count === 3
                      ? { auth: { ...refreshedSnapshotSecond.auth, workspaceId: "ws-b" } }
                      : {}),
                    usageLimits: {
                      checkedAt: "2026-04-10T00:00:03.000Z",
                      windows: [],
                      unavailable: { reason: "probeFailed" },
                    },
                  },
            ),
          ),
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Deferred.await(releaseEnrichment).pipe(
              Effect.flatMap(() =>
                publishSnapshot({
                  ...enrichedSnapshot,
                  ...snapshot,
                  models: enrichedSnapshot.models,
                }),
              ),
            ),
          refreshInterval: "1 hour",
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const liveWindow = {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 60,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [liveWindow],
        });

        yield* Deferred.succeed(releaseEnrichment, undefined);
        const enriched = yield* Stream.take(provider.streamChanges, 1).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]!),
        );
        assert.deepStrictEqual(enriched.models, enrichedSnapshot.models);
        assert.deepStrictEqual(enriched.usageLimits?.windows, [liveWindow]);

        const refreshed = yield* provider.refresh;
        assert.strictEqual(refreshed.message, refreshedSnapshotSecond.message);
        assert.deepStrictEqual(refreshed.usageLimits?.windows, [liveWindow]);
        assert.strictEqual(refreshed.auth.workspaceId, "ws-a");

        const switched = yield* provider.refresh;
        assert.strictEqual(switched.auth.workspaceId, "ws-b");
        assert.strictEqual(switched.usageLimits?.unavailable?.reason, "probeFailed");
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("keeps sparse usage unavailable after probe failure until a full probe recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failedLimits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Usage probe timed out." },
        } as const;
        const probeSnapshot = yield* Ref.make<ServerProvider>({
          ...refreshedSnapshot,
          usageLimits: failedLimits,
        });
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Ref.get(probeSnapshot),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);

        const weekly = {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 20,
        } as const;
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [weekly],
        });
        const partial = yield* provider.getSnapshot;
        assert.deepStrictEqual(partial.usageLimits, {
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [weekly],
          unavailable: failedLimits.unavailable,
        });
        yield* provider.applyUsageLimits({
          checkedAt: "2026-04-10T00:00:03.000Z",
          windows: [{ ...weekly }],
        });
        assert.strictEqual(yield* provider.getSnapshot, partial);
        assert.deepStrictEqual((yield* provider.refresh).usageLimits, failedLimits);

        const completeLimits = {
          checkedAt: "2026-04-10T00:00:04.000Z",
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
            { ...weekly, usedPercent: 25 },
          ],
        } as const;
        yield* Ref.set(probeSnapshot, { ...refreshedSnapshot, usageLimits: completeLimits });
        assert.deepStrictEqual((yield* provider.refresh).usageLimits, completeLimits);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("masks a committed snapshot when its probe scope no longer matches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make("A");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const count = yield* Ref.make(0);
        const scopes = new WeakMap<ServerProvider, string>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (a, b) => a.enabled !== b.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          currentScope: Ref.get(current),
          probeScope: (draft) => scopes.get(draft),
          checkProvider: Effect.gen(function* () {
            const scope = yield* Ref.get(current);
            const n = yield* Ref.updateAndGet(count, (x) => x + 1);
            if (n > 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            const draft = { ...refreshedSnapshot };
            scopes.set(draft, scope);
            return draft;
          }),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        yield* Ref.set(current, "B");
        const masked = yield* provider.getSnapshot;
        assert.strictEqual(masked.auth.status, "unknown");
        assert.strictEqual(masked.usageLimits, undefined);
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("does not retain usage across probe scopes and ignores stale session updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let current = "A";
        const scopes = new WeakMap<ServerProvider, string>();
        const limits = {
          checkedAt: "2026-04-10T00:00:01.000Z",
          windows: [{ id: "primary", kind: "session" as const, label: "Session", usedPercent: 10 }],
        };
        const failed = {
          checkedAt: "2026-04-10T00:00:02.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" as const },
        };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (a, b) => a.enabled !== b.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          currentScope: Effect.sync(() => current),
          probeScope: (draft) => scopes.get(draft),
          checkProvider: Effect.sync(() => {
            const draft = { ...refreshedSnapshot, usageLimits: current === "A" ? limits : failed };
            scopes.set(draft, current);
            return draft;
          }),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        current = "B";
        const next = yield* provider.refresh;
        assert.deepStrictEqual(next.usageLimits, failed);
        const update = {
          checkedAt: "2026-04-10T00:00:03.000Z",
          windows: [{ id: "primary", kind: "session" as const, label: "Session", usedPercent: 50 }],
        };
        yield* provider.applyUsageLimits(update, "A");
        assert.deepStrictEqual((yield* provider.getSnapshot).usageLimits, failed);
        yield* provider.applyUsageLimits(update, "B");
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 50);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("refreshes the newest scope after the current scope changes during a probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make("A");
        const startedB = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const startedC = yield* Deferred.make<void>();
        const scopes = new WeakMap<ServerProvider, string>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (a, b) => a.enabled !== b.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          currentScope: Ref.get(current),
          probeScope: (draft) => scopes.get(draft),
          checkProvider: Effect.gen(function* () {
            const scope = yield* Ref.get(current);
            if (scope === "B") {
              yield* Deferred.succeed(startedB, undefined);
              yield* Deferred.await(releaseB);
            }
            if (scope === "C") yield* Deferred.succeed(startedC, undefined);
            const draft = { ...refreshedSnapshot, message: scope };
            scopes.set(draft, scope);
            return draft;
          }),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        yield* Ref.set(current, "B");
        assert.strictEqual((yield* provider.getSnapshot).auth.status, "unknown");
        yield* Deferred.await(startedB);
        yield* Ref.set(current, "C");
        yield* Deferred.succeed(releaseB, undefined);
        yield* Deferred.await(startedC);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("masks a queued stream event from an older scope at consumption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const current = yield* Ref.make("A");
        const received = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const scopes = new WeakMap<ServerProvider, string>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (a, b) => a.enabled !== b.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          currentScope: Ref.get(current),
          probeScope: (draft) => scopes.get(draft),
          checkProvider: Ref.get(current).pipe(
            Effect.map((scope) => {
              const draft = { ...refreshedSnapshot, message: scope };
              scopes.set(draft, scope);
              return draft;
            }),
          ),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        const updates = yield* provider.streamChanges.pipe(
          Stream.mapEffect((snapshot) =>
            Deferred.succeed(received, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(snapshot),
            ),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* provider.refresh;
        yield* Deferred.await(received);
        yield* provider.refresh;
        yield* Ref.set(current, "B");
        yield* Deferred.succeed(release, undefined);
        const events = Array.from(yield* Fiber.join(updates));
        assert.strictEqual(events[1]?.auth.status, "unknown");
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
  it.effect("rejects a usage update from a different committed scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const draft = { ...refreshedSnapshot };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (a, b) => a.enabled !== b.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Effect.succeed(draft),
          probeScope: () => "B",
          currentScope: Effect.succeed("B"),
          refreshOnInterval: false,
        });
        yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
        const update = {
          checkedAt: "2026-04-10T00:00:03.000Z",
          windows: [{ id: "primary", kind: "session" as const, label: "Session", usedPercent: 50 }],
        };
        yield* provider.applyUsageLimits(update, "A");
        assert.strictEqual((yield* provider.getSnapshot).usageLimits, undefined);
        yield* provider.applyUsageLimits(update, "B");
        assert.strictEqual((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent, 50);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
