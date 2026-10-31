import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { BrowserOriginGrants } from "../../../../preview/BrowserOriginGrantsLayer.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";
import * as McpToolAccess from "../../../McpToolAccess.ts";
import { BrowserClaimToolkit, type BrowserClaimInput } from "./tools.ts";

export const requestClaim = Effect.fn("BrowserClaimMcp.request")(function* (
  input: BrowserClaimInput,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Browser claim request");
  const grants = yield* BrowserOriginGrants;
  return yield* grants.requestWindow({ ...input, threadId: caller.thread.threadId }).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Could not inspect the selected browser window.",
        }),
    ),
  );
});
export const listClaims = Effect.fn("BrowserClaimMcp.list")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Browser claim list");
  const grants = yield* BrowserOriginGrants;
  return yield* grants.list(caller.thread.threadId);
});
export const layer = McpToolAccess.toLayer(BrowserClaimToolkit, {
  goat_browser_claim_request: McpToolAccess.actsAsCaller(requestClaim),
  goat_browser_claim_list: McpToolAccess.readsAsCaller(listClaims),
});
