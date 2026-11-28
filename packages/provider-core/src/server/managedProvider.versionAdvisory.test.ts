import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { layerProviderHost } from "./managedProvider.testkit.ts";
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

const layerAlwaysRunTest = layerProviderHost({ runBackgroundWork: true });

describe("makeManagedServerProvider versionAdvisory", () => {
  it.effect("keeps a known update through a recheck of the same installed version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const advisory = (currentVersion: string, latestVersion: string | null) => ({
          status: latestVersion === null ? ("unknown" as const) : ("behind_latest" as const),
          currentVersion,
          latestVersion,
          updateCommand: maintenanceCapabilities.update.command,
          canUpdate: true,
          checkedAt: null,
          message: null,
        });
        const installedVersion = yield* Ref.make("1.0.0");
        const enrichments =
          yield* Queue.unbounded<(snapshot: ServerProvider) => Effect.Effect<void>>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => Effect.succeed(initialSnapshot),
          // Like a real probe, this reports the installed version but not the latest one.
          checkProvider: Ref.get(installedVersion).pipe(
            Effect.map((version) => ({
              ...refreshedSnapshot,
              version,
              versionAdvisory: advisory(version, null),
            })),
          ),
          enrichSnapshot: ({ publishSnapshot }) => Queue.offer(enrichments, publishSnapshot),
          refreshInterval: "1 hour",
        });
        const publishFirstEnrichment = yield* Queue.take(enrichments);
        yield* publishFirstEnrichment({
          ...refreshedSnapshot,
          version: "1.0.0",
          versionAdvisory: advisory("1.0.0", "2.0.0"),
        });

        const rechecked = yield* provider.refresh;
        assert.deepStrictEqual(rechecked.versionAdvisory, advisory("1.0.0", "2.0.0"));

        yield* Ref.set(installedVersion, "2.0.0");
        const updated = yield* provider.refresh;
        assert.deepStrictEqual(updated.versionAdvisory, advisory("2.0.0", null));
      }),
    ).pipe(Effect.provide(layerAlwaysRunTest)),
  );
});
