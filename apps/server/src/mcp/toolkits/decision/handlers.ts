import * as Effect from "effect/Effect";
import * as DecisionService from "../../../goatclaw/DecisionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DecisionToolkit } from "./tools.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => ({ kind: "agent" as const, scope })),
);
export const layer = McpToolAccess.toLayer(DecisionToolkit, {
  goat_decision_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* DecisionService.DecisionService).list(yield* caller, input);
    }),
  ),
  goat_decision_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      return yield* (yield* DecisionService.DecisionService).get(yield* caller, input);
    }),
  ),
  goat_decision_request: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* DecisionService.DecisionService).create(yield* caller, input);
    }),
  ),
  goat_decision_answer: McpToolAccess.destructive(
    McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        return yield* (yield* DecisionService.DecisionService).answer(yield* caller, input);
      }),
    ),
  ),
});
