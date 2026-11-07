import * as Effect from "effect/Effect";
import { BrowserOriginGrants } from "../../../../preview/BrowserOriginGrantsLayer.ts";
import { BrowserClaimHandoffs } from "../../../../preview/BrowserClaimHandoffs.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";
import * as McpToolAccess from "../../../McpToolAccess.ts";
import { BrowserClaimToolkit, type BrowserClaimInput } from "./tools.ts";

export const requestClaim = Effect.fn("BrowserClaimMcp.request")(function* (
  input: BrowserClaimInput,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Browser claim request");
  const bridge = yield* BrowserClaimHandoffs;
  return yield* bridge.request({
    ...input,
    threadId: caller.thread.threadId,
    providerInstanceId: caller.thread.providerInstanceId,
  });
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
