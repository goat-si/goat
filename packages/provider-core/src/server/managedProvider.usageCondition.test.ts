import { describe, it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

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

describe("makeManagedServerProvider usage conditions", () => {
  it.effect(
    "a usage update its condition rejects leaves the snapshot and its subscribers alone",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const probeSnapshot = yield* Ref.make<ServerProvider>(refreshedSnapshot);
          const provider = yield* makeManagedServerProvider<TestSettings>({
            resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(initialSnapshot),
            checkProvider: Ref.get(probeSnapshot),
            refreshOnInterval: false,
          });
          const accepted = (yield* provider.refresh).checkedAt;
          // A report judged against the shown snapshot, then a newer check commits before it applies.
          const appliesTo = (shown: ServerProvider) => shown.checkedAt === accepted;
          yield* Ref.set(probeSnapshot, {
            ...refreshedSnapshot,
            checkedAt: "2026-04-10T00:00:05.000Z",
          });
          const newer = yield* provider.refresh;
          const session = (usedPercent: number) =>
            ({ id: "five_hour", kind: "session", label: "Session", usedPercent }) as const;
          // Started immediately, the collector has subscribed before forkChild returns.
          const published = yield* Stream.take(provider.streamChanges, 2).pipe(
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* provider.applyUsageLimits(
            { checkedAt: "2026-04-10T00:00:06.000Z", windows: [session(40)] },
            { appliesTo },
          );
          assert.strictEqual(yield* provider.getSnapshot, newer);
          yield* provider.applyUsageLimits(
            { checkedAt: "2026-04-10T00:00:07.000Z", windows: [session(70)] },
            { appliesTo: (shown) => shown.checkedAt === newer.checkedAt },
          );
          assert.deepStrictEqual((yield* provider.getSnapshot).usageLimits?.windows, [session(70)]);
          // Without a condition an update applies as it always has.
          yield* provider.applyUsageLimits({
            checkedAt: "2026-04-10T00:00:08.000Z",
            windows: [session(80)],
          });
          // The rejected update published nothing: subscribers see only the two that applied.
          const events = Array.from(yield* Fiber.join(published));
          assert.deepStrictEqual(
            events.map((event) => event.usageLimits?.windows),
            [[session(70)], [session(80)]],
          );
        }),
      ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
