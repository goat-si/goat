import { expect, it } from "@effect/vitest";
import { AgentScope } from "@goat/shared/AgentScope";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Effect from "effect/Effect";

import { withAgentOom } from "./agentOomFailure.ts";

it.effect.each([false, true])(
  "rewrites a provider failure only when its thread is OOM-marked (%s)",
  (killed) =>
    Effect.gen(function* () {
      const failure = makeProviderFailure({
        message: "provider failed",
        code: "provider_error",
        class: "unknown",
      });
      const result = yield* withAgentOom("thread", failure).pipe(
        Effect.provideService(AgentScope, {
          ...AgentScope.defaultValue(),
          oomKilled: (threadId) => Effect.succeed(killed && threadId === "thread"),
        }),
      );
      expect(result).toEqual(
        killed ? { ...failure, message: "Killed: out of memory.", code: "oom_kill" } : failure,
      );
    }),
);
