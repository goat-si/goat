import {
  type AgentSurfaceResult,
  type CallContext,
  declaredFailureLiteral,
  fromFailure,
  fromInvalidParams,
  fromToolResult,
} from "@goat/contracts/agentSurface/envelope";
import type { AgentSurfaceEffect } from "@goat/contracts/agentSurface";
import { isDeduplicatedCall, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { toSignature } from "@goat/contracts/agentSurface/signature";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as McpToolAccess from "../../McpToolAccess.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import { defectSummary } from "../../../observability/LogRedaction.ts";
import { argumentKeys } from "../../toolRefusals.ts";
import { surfaceArgumentAliases } from "./argumentAliases.ts";
import { ForwardedContent } from "./forwardedContent.ts";

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A refusal of arguments the target never ran with, carrying its one-line signature. */
const withExpectedSignature = (
  result: AgentSurfaceResult,
  schema: unknown,
  name: string,
): AgentSurfaceResult => {
  if (result.status !== "error" || !isRecord(schema)) return result;
  const { details } = result.error;
  if (details !== undefined && !isRecord(details)) return result;
  const expectedSignature = toSignature(pathOf(name) ?? name, schema);
  return { ...result, error: { ...result.error, details: { ...details, expectedSignature } } };
};

/**
 * Whether /mcp refuses these arguments before the handler for a key the target does not declare,
 * judged as McpHttpServer judges it: after folding aliases, unless the schema takes extra keys.
 */
const refusesUndeclared = (name: string, schema: unknown, args: unknown) => {
  if (!isRecord(schema) || isRecord(schema.additionalProperties)) return false;
  const folded = surfaceArgumentAliases(name, args);
  if (!folded.ok) return false;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return argumentKeys(folded.payload).some((key) => !Object.hasOwn(properties, key));
};

/** Where a routed call ran, so the agent can tell remote results from local ones. */
const withHost = (result: AgentSurfaceResult, host: string | undefined): AgentSurfaceResult =>
  host === undefined ? result : { ...result, meta: { ...result.meta, host } };

/**
 * Hands a target's non-text blocks to goat_call's registration, which returns them as content
 * blocks; left in the envelope, their bytes could not be encoded. Without that registration, as
 * for the operation verbs, the envelope keeps them.
 */
const forwardContent = Effect.fn("AgentSurface.forwardContent")(function* (
  result: AgentSurfaceResult,
) {
  const blocks = result.status === "ok" ? result.meta?.content : undefined;
  const forwarded = yield* Effect.serviceOption(ForwardedContent);
  if (blocks === undefined || Option.isNone(forwarded) || result.status !== "ok") return result;
  yield* forwarded.value.add(blocks);
  const { content: _content, ...meta } = result.meta ?? {};
  const { meta: _meta, ...rest } = result;
  return Object.keys(meta).length === 0 ? rest : { ...rest, meta };
});

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
  // A key ToolAdmission reserves or the write's own store deduplicates makes a repeat safe.
  const entry = resolveAgentSurfaceEntry(name);
  const deduplicated = entry !== undefined && isDeduplicatedCall(entry, args);
  const context: CallContext = { effect, deduplicated, pathOf };
  const schema = dispatch.served(name)?.inputSchema;
  const undeclared = refusesUndeclared(name, schema, args);
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
    // Refused before the handler, so the target cannot have answered with a refusal of its own.
    Effect.map((result) => (undeclared ? withExpectedSignature(result, schema, name) : result)),
    Effect.map((result) => withHost(result, host)),
    Effect.flatMap(forwardContent),
    // A dying target still gets an answer, with the same fixed text a direct call shows; the
    // cause goes to the log, since the answer carries none.
    Effect.catchDefect((defect) =>
      Effect.logError("goat_call target died", { tool: name, defect: defectSummary(defect) }).pipe(
        Effect.as(
          envelopeError(
            "internal",
            "tool_error",
            "Tool execution failed due to an internal server error.",
          ),
        ),
      ),
    ),
    Effect.catchTags({
      InvalidParams: (error) =>
        Effect.succeed(withExpectedSignature(fromInvalidParams(error.message), schema, name)),
      InternalError: (error) =>
        Effect.succeed(envelopeError("internal", "internal_error", error.message)),
    }),
  );
});

/**
 * A keyed write's recorded result, answered as goat_call answers the call that recorded it, for a
 * caller that must not send the write again (goat_eval's recovery of an interrupted step).
 */
export const storedEnvelope = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  effect: AgentSurfaceEffect,
  result: Parameters<typeof fromToolResult>[0],
  failure: { readonly _tag: string; readonly code?: string } | undefined,
): AgentSurfaceResult => {
  const entry = resolveAgentSurfaceEntry(name);
  const context: CallContext = { effect, deduplicated: true, pathOf };
  const direct = fromToolResult(result, context);
  const host =
    entry?.hostRoutable === true && typeof args.host === "string" ? args.host : undefined;
  return withHost(
    result.isError === true && failure !== undefined
      ? reclassified(direct, failure, context)
      : direct,
    host,
  );
};
