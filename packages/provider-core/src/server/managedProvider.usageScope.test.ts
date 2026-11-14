import { it, assert } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

type TestSettings = { readonly enabled: boolean };
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
  models: [],
  slashCommands: [],
  skills: [],
};
const refreshedSnapshot: ServerProvider = {
  ...initialSnapshot,
  status: "ready",
  auth: { status: "authenticated" },
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
