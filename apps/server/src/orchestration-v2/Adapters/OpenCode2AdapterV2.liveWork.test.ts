import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";

import {
  CHILD,
  SESSION,
  backgroundLaunch,
  event,
  out,
  reply,
  resumed,
  withLineage,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 live work", (it) => {
  it.effect(
    "holds a retiring session while a background child runs, until OpenCode says it ended",
    () =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed([
          ...backgroundLaunch(CHILD),
          event("session.execution.started", { sessionID: CHILD }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("session.active"),
          reply("session.active", { data: { [CHILD]: { type: "running" } } }),
          out("session.active"),
          reply("session.active", { data: {} }),
          out("session.active"),
          reply("session.active", { status: 502, body: { _tag: "UnknownError", message: "gone" } }),
        ]);
        const parentEnded = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Deferred.succeed(parentEnded, undefined) : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(parentEnded);
        const holdsLiveWork = runtime.holdsLiveWork;
        assert.isDefined(holdsLiveWork);
        if (holdsLiveWork === undefined) return;

        assert.isTrue(yield* holdsLiveWork({ pastPinCeiling: false }));
        // Past the pin ceiling the cached state is confirmed with OpenCode.
        assert.isTrue(yield* holdsLiveWork({ pastPinCeiling: true }));
        assert.isFalse(yield* holdsLiveWork({ pastPinCeiling: true }));
        // A server that cannot answer holds nothing, so a dead server never pins its session.
        assert.isFalse(yield* holdsLiveWork({ pastPinCeiling: true }));
      }).pipe(Effect.scoped),
  );
});
