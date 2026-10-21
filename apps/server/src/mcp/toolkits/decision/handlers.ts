import * as Effect from "effect/Effect";
import * as DecisionInbox from "../../../goatclaw/DecisionInbox.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DecisionToolkit } from "./tools.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => ({ kind: "agent" as const, scope })),
);
export const layer = McpToolAccess.toLayer(DecisionToolkit, {
  goat_decision_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* DecisionInbox.DecisionInbox).list(yield* caller, input);
    }),
  ),
  goat_decision_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* DecisionInbox.DecisionInbox).get(yield* caller, input.id);
    }),
  ),
  goat_decision_request: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* DecisionInbox.DecisionInbox).create(yield* caller, input);
    }),
  ),
  goat_decision_answer: McpToolAccess.destructive(
    McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        return yield* (yield* DecisionInbox.DecisionInbox).answer(yield* caller, input);
      }),
    ),
  ),
});
