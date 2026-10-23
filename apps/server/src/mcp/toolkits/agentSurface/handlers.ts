import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import {
  canonicalToolName,
  isKeyedWrite,
  resolveAgentSurfaceEntry,
} from "@goat/contracts/agentSurface/resolve";
import {
  type AgentSurfaceResult,
  type CallContext,
  declaredFailureLiteral,
  fromFailure,
  fromInvalidParams,
  fromToolResult,
} from "@goat/contracts/agentSurface/envelope";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ToolDispatch } from "../../ToolDispatch.ts";
import { AgentSurfaceToolkit, type DescribeResult } from "./tools.ts";

const entries: ReadonlyArray<AgentSurfaceRegistryEntry> = Object.values(agentSurfaceRegistry);

// FNV-1a over what an agent relies on; stable across processes, unlike object identity.
const surfaceVersion = (() => {
  let hash = 0x811c9dc5;
  for (const entry of entries)
    for (const char of `${entry.path}|${entry.name}|${entry.effect}|${entry.requires}|${entry.description}\n`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  return hash.toString(16).padStart(8, "0");
})();
// Calling these through goat_call would only nest the same checks, or recurse.
const NOT_CALLABLE: ReadonlySet<string> = new Set(["surface.call", "surface.eval"]);

type Availability = { readonly now: boolean; readonly reason?: string };
type Scope = McpInvocationContext.McpInvocationScope;

/** Only the static refusals this server is sure of; handlers still check at call time. */
const availability = (
  entry: AgentSurfaceRegistryEntry,
  scope: Scope,
  served: boolean,
): Availability => {
  if (!served) return { now: false, reason: "This GOAT server does not serve it." };
  if (entry.resource === "surface") return { now: true };
  if (entry.requires === "thread" && scope.thread === undefined)
    return { now: false, reason: "Needs an agent running inside a GOAT thread." };
  if (entry.requires === "client" && scope.thread !== undefined)
    return { now: false, reason: "Only an outside MCP client can call it." };
  if (entry.effect !== "read" && scope.client?.access === "read-only")
    return { now: false, reason: "This MCP client was approved for read-only access." };
  return { now: true };
};

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

const envelopeError = (
  code: "invalid_request" | "not_found" | "internal",
  reason: string,
  message: string,
): AgentSurfaceResult => ({ status: "error", error: { code, reason, message, retryable: false } });

export const layer = McpToolAccess.toLayer(
  AgentSurfaceToolkit,
  Effect.gen(function* () {
    const dispatch = yield* ToolDispatch;

    const summary = (entry: AgentSurfaceRegistryEntry, scope: Scope) => ({
      path: entry.path,
      name: entry.name,
      summary: entry.summary,
      effect: entry.effect,
      available: availability(entry, scope, dispatch.served(entry.name) !== undefined),
    });

    const describe = Effect.fn("AgentSurface.describe")(function* (input: {
      readonly path?: string | undefined;
    }) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (input.path === undefined) {
        const resources = new Map<string, Array<string>>();
        for (const entry of entries)
          resources.set(entry.resource, [...(resources.get(entry.resource) ?? []), entry.verb]);
        return {
          depth: "surface" as const,
          surfaceVersion,
          resources: [...resources.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([resource, verbs]) => ({ resource, verbs: verbs.sort() })),
          next: 'Pass a resource ("thread") for its paths, or a path ("thread.send") for its schema and availability. Call any path with goat_call.',
        } satisfies DescribeResult;
      }
      const entry = resolveAgentSurfaceEntry(input.path);
      if (entry !== undefined) {
        const tool = dispatch.served(entry.name);
        return {
          depth: "path" as const,
          entry: {
            ...summary(entry, scope),
            canonicalName: canonicalToolName(entry),
            legacyNames: entry.legacyNames,
            description: entry.description,
            hostRoutable: entry.hostRoutable,
            requires: entry.requires,
            dryRun: entry.dryRun,
            humanSteps: entry.humanSteps,
            inputSchema: tool?.inputSchema ?? null,
            outputSchema: tool?.outputSchema ?? null,
          },
        } satisfies DescribeResult;
      }
      const inResource = entries.filter((candidate) => candidate.resource === input.path);
      if (inResource.length === 0)
        return yield* new OrchestratorMcpFailure({
          code: "not_found",
          message: `GOAT has no resource or path named ${input.path}. Call goat_describe without path to list them.`,
        });
      return {
        depth: "resource" as const,
        resource: input.path,
        entries: inResource
          .toSorted((a, b) => a.verb.localeCompare(b.verb))
          .map((candidate) => summary(candidate, scope)),
      } satisfies DescribeResult;
    });

    const call = Effect.fn("AgentSurface.call")(function* (input: {
      readonly path: string;
      readonly args?: Readonly<Record<string, unknown>> | undefined;
    }) {
      const entry = resolveAgentSurfaceEntry(input.path);
      if (entry === undefined)
        return envelopeError(
          "not_found",
          "unknown_path",
          `GOAT has no capability named ${input.path}. Find paths with goat_describe.`,
        );
      if (NOT_CALLABLE.has(entry.path))
        return envelopeError(
          "invalid_request",
          "not_callable",
          `${entry.name} cannot run inside goat_call. Call it directly.`,
        );
      if (dispatch.served(entry.name) === undefined)
        return envelopeError(
          "not_found",
          "not_served",
          `This GOAT server does not serve ${entry.name}.`,
        );
      const captured = yield* Ref.make<unknown>(undefined);
      const args = input.args ?? {};
      // Only keyed writes that carry a key are deduplicated; ToolAdmission holds the key.
      const deduplicated = isKeyedWrite(entry) && typeof args.clientRequestId === "string";
      const context: CallContext = { effect: entry.effect, deduplicated, pathOf };
      const host = entry.hostRoutable && typeof args.host === "string" ? args.host : undefined;
      return yield* dispatch.call(entry.name, args).pipe(
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

    return {
      goat_describe: McpToolAccess.reads(describe),
      // Destructive so clients that prompt on destructive tools still prompt for the targets that are.
      goat_call: McpToolAccess.destructive(McpToolAccess.dispatches(call)),
    };
  }),
);
