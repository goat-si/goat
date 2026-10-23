import {
  type AgentSurfaceResult,
  type CallContext,
  declaredFailureLiteral,
  fromFailure,
  fromInvalidParams,
  fromToolResult,
} from "@goat/contracts/agentSurface/envelope";
import type { AgentSurfaceEffect } from "@goat/contracts/agentSurface";
import { isKeyedWrite, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as McpToolAccess from "../../McpToolAccess.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";

/**
 * Reclassifies a direct failure by its declared literal; the text stays what a direct call shows.
 * A failure that says the write may have started stays unknown_outcome whatever its literal.
 */
const reclassified = (
  direct: AgentSurfaceResult,
  error: unknown,
  context: CallContext,
): AgentSurfaceResult => {
  const declared = declaredFailureLiteral(error);
  if (direct.status !== "error" || declared === undefined) return direct;
  const mayHaveStarted =
    direct.error.code === "unknown_outcome" ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly mayHaveStarted?: unknown }).mayHaveStarted === true);
  const classified = fromFailure(
    { ...declared, message: direct.error.message, ...(mayHaveStarted ? { mayHaveStarted } : {}) },
    context,
  );
  if (classified.status !== "error") return direct;
  return {
    ...direct,
    error: {
      ...classified.error,
      ...(direct.error.details === undefined ? {} : { details: direct.error.details }),
    },
  };
};

const pathOf = (toolName: string) => resolveAgentSurfaceEntry(toolName)?.path;

/** Where a routed call ran, so the agent can tell remote results from local ones. */
const withHost = (result: AgentSurfaceResult, host: string | undefined): AgentSurfaceResult =>
  host === undefined ? result : { ...result, meta: { ...result.meta, host } };

export const envelopeError = (
  code: "invalid_request" | "not_found" | "internal",
  reason: string,
  message: string,
): AgentSurfaceResult => ({ status: "error", error: { code, reason, message, retryable: false } });

/**
 * Runs one registered tool through the handle /mcp serves, so its own checks apply, and returns
 * its answer as an envelope. goat_call and the operation verbs share it.
 */
export const dispatchEnvelope = Effect.fn("AgentSurface.dispatch")(function* (
  dispatch: ToolDispatch["Service"],
  name: string,
  args: Readonly<Record<string, unknown>>,
  effect: AgentSurfaceEffect,
  host?: string,
) {
  const captured = yield* Ref.make<unknown>(undefined);
  // Only a keyed write that carries a key is deduplicated; ToolAdmission holds the key.
  const entry = resolveAgentSurfaceEntry(name);
  const deduplicated =
    entry !== undefined && isKeyedWrite(entry) && typeof args.clientRequestId === "string";
  const context: CallContext = { effect, deduplicated, pathOf };
  return yield* dispatch.call(name, args).pipe(
    Effect.provideService(McpToolAccess.CallFailureCapture, {
      record: (error) => Ref.set(captured, error),
    }),
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.map(Ref.get(captured), (error) =>
            reclassified(fromToolResult(result, context), error, context),
          )
        : Effect.succeed(fromToolResult(result, context)),
    ),
    Effect.map((result) => withHost(result, host)),
    // A dying target still gets an answer, with the same fixed text a direct call shows.
    Effect.catchDefect(() =>
      Effect.succeed(
        envelopeError(
          "internal",
          "tool_error",
          "Tool execution failed due to an internal server error.",
        ),
      ),
    ),
    Effect.catchTags({
      InvalidParams: (error) => Effect.succeed(fromInvalidParams(error.message)),
      InternalError: (error) =>
        Effect.succeed(envelopeError("internal", "internal_error", error.message)),
    }),
  );
});
