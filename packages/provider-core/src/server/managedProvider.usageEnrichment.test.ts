import * as Queue from "effect/Queue";
import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

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

const layerAlwaysRunTest = Layer.succeed(
  ProviderHost.ProviderHost,
  ProviderHost.ProviderHost.of({
    paths: {
      cwd: process.cwd(),
      baseDir: "/t3",
      stateDir: "/t3/userdata",
      providerStatusCacheDir: "/t3/caches",
      attachmentsDir: "/t3/userdata/attachments",
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(true),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("unused"),
  }),
);

describe("managed provider usage enrichment", () => {
  it.effect("streams optional account usage independently of readiness and discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseCheck = yield* Deferred.make<void>();
        const releaseUsage = yield* Deferred.make<void>();
        const releaseDiscovery = yield* Deferred.make<void>();
        const usageLimits = { checkedAt: refreshedSnapshot.checkedAt, windows: [] };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(Effect.as(refreshedSnapshot)),
          enrichUsageLimits: () => Deferred.await(releaseUsage).pipe(Effect.as(usageLimits)),
          enrichSnapshot: ({ publishSnapshot }) =>
            Deferred.await(releaseDiscovery).pipe(
              Effect.flatMap(() => publishSnapshot(enrichedSnapshot)),
            ),
          refreshInterval: "1 hour",
        });
        const updates = yield* provider.streamChanges.pipe(
          Stream.toQueue({ capacity: "unbounded" }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseCheck, undefined);
        assert.deepStrictEqual(yield* Queue.take(updates), refreshedSnapshot);
        yield* Deferred.succeed(releaseUsage, undefined);
        assert.deepStrictEqual(yield* Queue.take(updates), { ...refreshedSnapshot, usageLimits });
        yield* Deferred.succeed(releaseDiscovery, undefined);
        assert.deepStrictEqual(yield* Queue.take(updates), { ...enrichedSnapshot, usageLimits });
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );

  it.effect("clears old optional account usage and cancels a pending read on a new check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseCheck = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const secondCancelled = yield* Deferred.make<void>();
        const readCount = yield* Ref.make(0);
        const checkCount = yield* Ref.make(0);
        const usageLimits = { checkedAt: refreshedSnapshot.checkedAt, windows: [] };
        const signedOutSnapshot: ServerProvider = {
          ...refreshedSnapshotSecond,
          auth: { status: "unauthenticated" },
        };
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          checkProvider: Deferred.await(releaseCheck).pipe(
            Effect.andThen(Ref.updateAndGet(checkCount, (n) => n + 1)),
            Effect.map((n) =>
              n === 1 ? refreshedSnapshot : n === 2 ? refreshedSnapshotSecond : signedOutSnapshot,
            ),
          ),
          enrichUsageLimits: () =>
            Ref.updateAndGet(readCount, (n) => n + 1).pipe(
              Effect.flatMap((n) =>
                n === 1
                  ? Effect.succeed(usageLimits)
                  : Deferred.succeed(secondStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() => Deferred.succeed(secondCancelled, undefined)),
                    ),
              ),
            ),
          refreshInterval: "1 hour",
        });
        const updates = yield* provider.streamChanges.pipe(
          Stream.toQueue({ capacity: "unbounded" }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseCheck, undefined);
        assert.deepStrictEqual(yield* Queue.take(updates), refreshedSnapshot);
        assert.deepStrictEqual(yield* Queue.take(updates), { ...refreshedSnapshot, usageLimits });
        assert.deepStrictEqual(yield* provider.refresh, refreshedSnapshotSecond);
        yield* Deferred.await(secondStarted);
        assert.deepStrictEqual(yield* provider.getSnapshot, refreshedSnapshotSecond);
        assert.deepStrictEqual(yield* provider.refresh, signedOutSnapshot);
        yield* Deferred.await(secondCancelled);
        assert.deepStrictEqual(yield* provider.getSnapshot, signedOutSnapshot);
        assert.strictEqual(yield* Ref.get(readCount), 2);
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
