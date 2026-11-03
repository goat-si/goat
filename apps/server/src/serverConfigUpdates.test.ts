import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import { applyProviderStatusChanges } from "@goat/shared/providerStatusChanges";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { resolveOpenDiscoveryForConfig, withProviderStatusChanges } from "./serverConfigUpdates.ts";

const provider = (instanceId: string, checkedAt: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [{ name: "skill", path: "/skills/" + instanceId, enabled: true }],
});

const snapshot = (providers: ReadonlyArray<ServerProvider>): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config: { providers } as unknown as ServerConfig,
});
const statuses = (providers: ReadonlyArray<ServerProvider>): ServerConfigStreamEvent => ({
  version: 1,
  type: "providerStatuses",
  payload: { providers },
});

it.effect(
  "a subscriber that asked for changes gets only what differs from what it last received",
  () =>
    Effect.gen(function* () {
      const first = [
        provider("codex", "2026-10-30T00:00:00.000Z"),
        provider("claude", "2026-10-30T00:00:00.000Z"),
      ];
      const refreshed = [provider("codex", "2026-10-30T00:01:00.000Z"), first[1]!];
      const later = [refreshed[0]!, provider("claude", "2026-10-30T00:02:00.000Z")];

      const events = Array.from(
        yield* withProviderStatusChanges(
          Stream.make(
            snapshot(first),
            statuses(refreshed),
            statuses(refreshed),
            snapshot(refreshed),
            statuses(later),
          ),
        ).pipe(Stream.runCollect),
      );

      assert.deepEqual(
        events.map((event) => event.type),
        ["snapshot", "providerStatusChanges", "snapshot", "providerStatusChanges"],
      );
      const [, change, , next] = events;
      if (change?.type !== "providerStatusChanges" || next?.type !== "providerStatusChanges") {
        return yield* Effect.die("Expected provider status changes");
      }
      assert.deepEqual(
        change.payload.instanceIds,
        refreshed.map((entry) => entry.instanceId),
      );
      assert.deepEqual(
        change.payload.providers.map((entry) => entry.instanceId),
        ["codex"],
      );
      assert.notProperty(change.payload.providers[0], "skills");
      assert.deepEqual(applyProviderStatusChanges(first, change.payload), refreshed);
      assert.deepEqual(
        next.payload.providers.map((entry) => entry.instanceId),
        ["claude"],
      );
      assert.deepEqual(applyProviderStatusChanges(refreshed, next.payload), later);
    }),
);

it.effect("runs editor, remote target and direct endpoint discovery concurrently", () =>
  Effect.gen(function* () {
    const editorsStarted = yield* Deferred.make<void>();
    const targetsStarted = yield* Deferred.make<void>();
    const endpointsStarted = yield* Deferred.make<void>();
    const startThenAwait = <A>(started: Deferred.Deferred<void>, value: A) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          Effect.forEach([editorsStarted, targetsStarted, endpointsStarted], Deferred.await),
        ),
        Effect.as(value),
      );
    const discovery = yield* resolveOpenDiscoveryForConfig({
      editors: startThenAwait(editorsStarted, ["file-manager" as const]),
      fileManagerRevealKind: Effect.succeed("finder" as const),
      remoteOpenTargets: startThenAwait(targetsStarted, []),
      directEndpoints: startThenAwait(endpointsStarted, []),
    });
    assert.deepEqual(discovery, {
      availableEditors: ["file-manager"],
      shellRevealInFileManager: true,
      shellRevealInFileManagerKind: "finder",
      remoteOpenTargets: [],
      directEndpoints: [],
    });
  }),
);
