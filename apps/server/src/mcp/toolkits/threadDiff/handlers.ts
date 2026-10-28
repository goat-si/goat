import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadDiffMcpService from "../../ThreadDiffMcpService.ts";
import { ThreadDiffToolkit } from "./tools.ts";

const handlers = {
  goat_thread_turn_diff: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadDiffMcpService.ThreadDiffMcpService;
      return yield* service.turnDiff(scope, input);
    }),
  ),
  goat_thread_diff: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ThreadDiffMcpService.ThreadDiffMcpService;
      return yield* service.fullDiff(scope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ThreadDiffToolkit.tools>;

export const layer = McpToolAccess.toLayer(ThreadDiffToolkit, handlers);
