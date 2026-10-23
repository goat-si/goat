import {
  FAILURE_CLASSES,
  type AgentSurfaceResult,
  type CallContext,
  fromFailure,
  fromInvalidParams,
  fromToolResult,
} from "@goat/contracts/agentSurface/envelope";
import type { AgentSurfaceEffect } from "@goat/contracts/agentSurface";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as McpToolAccess from "../../McpToolAccess.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";

const stringField = (value: unknown, key: string) => {
  const field =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
};

/**
 * The declared domain literal behind a failure, which the MCP layer may have flattened to text.
 * Only literals the classification table names count: an undeclared failure is one the direct
 * call deliberately scrubs, so goat_call must not reveal even its tag. Free text such as a
 * reason string or a computed message never leaves through here.
 */
const declaredLiteral = (
  error: unknown,
): { readonly _tag: string; readonly code?: string } | undefined => {
  const tag = stringField(error, "_tag");
  if (tag === undefined) return undefined;
  const literal = (["code", "reason", "failureCode"] as const)
    .map((key) => stringField(error, key))
    .find((value) => value !== undefined && FAILURE_CLASSES[value] !== undefined);
  if (literal !== undefined) return { _tag: tag, code: literal };
  return FAILURE_CLASSES[tag] === undefined ? undefined : { _tag: tag };
};

/** Reclassifies a direct failure by its declared literal; the text stays what a direct call shows. */
const reclassified = (
  direct: AgentSurfaceResult,
  error: unknown,
  context: CallContext,
): AgentSurfaceResult => {
  const declared = declaredLiteral(error);
  if (direct.status !== "error" || declared === undefined) return direct;
  const classified = fromFailure({ ...declared, message: direct.error.message }, context);
  if (classified.status !== "error") return direct;
  return {
    ...direct,
    error: {
      ...classified.error,
      ...(direct.error.details === undefined ? {} : { details: direct.error.details }),
    },
  };
};

export const pathOf = (toolName: string) => resolveAgentSurfaceEntry(toolName)?.path;

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
  // Writes count as unkeyed until the registry says which ones the server deduplicates.
  const context: CallContext = { effect, pathOf };
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
