import { type LlmsTxtCaller, renderLlmsTxt } from "@goat/contracts/agentSurface/llms";
import { HttpServerResponse } from "effect/http";

import type * as McpInvocationContext from "./McpInvocationContext.ts";

export const llmsTxtCaller = (scope: McpInvocationContext.McpInvocationScope): LlmsTxtCaller =>
  scope.client === undefined
    ? { kind: "thread" }
    : { kind: "client", readOnly: scope.client.access === "read-only" };

/** /llms.txt for a caller. */
export const llmsTxtResponse = (caller: LlmsTxtCaller) =>
  HttpServerResponse.text(renderLlmsTxt(caller), {
    contentType: "text/plain; charset=utf-8",
    // The body depends on the credential, so no shared cache may keep it.
    headers: { "cache-control": "no-store", vary: "authorization" },
  });
