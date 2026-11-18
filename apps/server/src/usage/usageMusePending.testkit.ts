// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type UsageSummary } from "@goat/contracts";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import * as MuseSdk from "../../../../packages/provider-muse/src/server/sdk.ts";
import { totalOutputTokens } from "./UsageAssertions.testkit.ts";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

// Registered from UsageService.test.ts, whose vi.mock of the Muse SDK makes createMuseSdkHostEffect spyable.
export function registerMusePendingTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  claudeLine: typeof Main.claudeLine,
) {
  it.effect("returns other providers' usage while Muse home discovery is still pending", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const museStarted = yield* Deferred.make<void>();
      const museReady = yield* Deferred.make<MuseSdk.MuseSdkHost>();
      const museHome = NodePath.join(home, "muse");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(museHome, "sessions"), { recursive: true }),
      );
      using _create = vi
        .spyOn(MuseSdk, "createMuseSdkHostEffect")
        .mockImplementation(() =>
          Deferred.succeed(museStarted, undefined).pipe(Effect.andThen(Deferred.await(museReady))),
        );
      const museSources = (summary: UsageSummary) =>
        summary.sources
          .filter((source) => source.fingerprint.provider === "muse")
          .map((source) => [source.fingerprint.resolvedHomePath, source.status, source.refreshing]);
      const [pending, refreshed] = yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const read = yield* Effect.forkChild(service.readSummary(WINDOW));
        yield* Deferred.await(museStarted);
        const pending = yield* Fiber.join(read);
        const refresh = yield* Effect.forkChild(
          service.readSummary({ ...WINDOW, awaitRefresh: true }),
        );
        yield* Deferred.succeed(museReady, {
          initializeResult: { grantedCapabilities: [], museHome },
          close: async () => {},
        } as unknown as MuseSdk.MuseSdkHost);
        return [pending, yield* Fiber.join(refresh)] as const;
      }).pipe(
        Effect.scoped,
        Effect.provideService(SpawnExecutableResolution, (command: string) => command),
        Effect.provide(
          layerService({
            prefix: "usage-muse-pending",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("muse")]: {
                  driver: ProviderDriverKind.make("muse"),
                  enabled: false,
                },
              },
            },
          }),
        ),
      );
      assert.strictEqual(totalOutputTokens(pending), 5);
      assert.deepStrictEqual(museSources(pending), [["muse", "ok", true]]);
      assert.deepStrictEqual(museSources(refreshed), [
        [NodePath.join(museHome, "sessions"), "ok", undefined],
      ]);
    }).pipe(Effect.scoped),
  );
}
