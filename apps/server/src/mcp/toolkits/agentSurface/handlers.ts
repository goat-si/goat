import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import { canonicalToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import {
  FAILURE_CLASSES,
  type AgentSurfaceResult,
  type CallContext,
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

/** goat_describe's query returns this many paths and reads one more to say whether others match. */
const SEARCH_LIMIT = 20;

/**
 * Every word must appear in the path, summary or description; a word in the path counts most.
 * Ties keep registry order by path, so the same query always answers the same way.
 */
const search = (candidates: ReadonlyArray<AgentSurfaceRegistryEntry>, query: string) => {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const scored: Array<{ readonly entry: AgentSurfaceRegistryEntry; readonly score: number }> = [];
  for (const entry of candidates) {
    const path = `${entry.path} ${entry.name}`.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const description = entry.description.toLowerCase();
    let score = 0;
    for (const word of words) {
      const points = path.includes(word)
        ? 3
        : summary.includes(word)
          ? 2
          : description.includes(word)
            ? 1
            : 0;
      if (points === 0) {
        score = 0;
        break;
      }
      score += points;
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored
    .toSorted((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .map(({ entry }) => entry);
};

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
      readonly query?: string | undefined;
    }) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (input.query !== undefined) {
        const within =
          input.path === undefined
            ? entries
            : entries.filter((candidate) => candidate.resource === input.path);
        if (within.length === 0)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `query searches every path or one resource, and GOAT has no resource named ${input.path}.`,
          });
        const matches = search(within, input.query);
        return {
          depth: "search" as const,
          query: input.query,
          entries: matches.slice(0, SEARCH_LIMIT).map((entry) => summary(entry, scope)),
          truncated: matches.length > SEARCH_LIMIT,
        } satisfies DescribeResult;
      }
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
      // Writes count as unkeyed until the registry says which ones the server deduplicates.
      const context: CallContext = { effect: entry.effect, pathOf };
      const args = input.args ?? {};
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
