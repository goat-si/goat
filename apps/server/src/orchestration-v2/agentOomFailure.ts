import type { OrchestrationV2ProviderFailure } from "@goat/contracts";
import { AgentScope } from "@goat/shared/AgentScope";
import * as Effect from "effect/Effect";
export const withAgentOom = Effect.fn("AgentOomFailure.withAgentOom")(function* (
  threadId: string,
  failure: OrchestrationV2ProviderFailure,
) {
  const scope = yield* AgentScope;
  return (yield* scope.oomKilled(threadId))
    ? { ...failure, message: "Killed: out of memory.", code: "oom_kill" }
    : failure;
});
