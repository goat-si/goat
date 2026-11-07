import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

import { fixture, layerAdapterTest } from "./CodexAdapterV2.attachment.testkit.ts";

// After a GOAT server restart a surviving Codex app-server still holds the thread with the credential
// the earlier server installed, and Codex ignores the overrides a resume of a held thread carries.
describe("Codex credential after a server restart", () => {
  it.effect(
    "a thread Codex already held is reloaded with the new credential at its next quiet turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("restart-held");
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          // Codex answers the resume idle, as it does for a held thread it rejoins.
          f.resume(2, f.threadParams());
          yield* f.turnStart(f.reload(3, undefined, { terminals: true }), 1, false);
          f.turnCompleted(1);
          const replay = yield* f.openResumed("idle");
          yield* replay.startTurn(1);
          yield* replay.terminal;
          assert.include(replay.requests, "thread/unsubscribe");
          assert.deepEqual(
            replay.threadConfigs.map((config) => config["mcp_servers.goat"]),
            [
              f.threadParams().config["mcp_servers.goat"],
              f.threadParams().config["mcp_servers.goat"],
            ],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect("a thread Codex loaded from the resume keeps the credential without a reload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = fixture("restart-cold");
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(f.config);
        f.resume(2, f.threadParams());
        yield* f.turnStart(3, 1, false);
        f.turnCompleted(1);
        const replay = yield* f.openResumed("notLoaded");
        yield* replay.startTurn(1);
        yield* replay.terminal;
        assert.notInclude(replay.requests, "thread/unsubscribe");
      }),
    ).pipe(Effect.provide(layerAdapterTest)),
  );
});
