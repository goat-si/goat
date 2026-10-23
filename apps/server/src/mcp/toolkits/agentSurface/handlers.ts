import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import {
  canonicalToolName,
  deprecatedReplacement,
  listedToolName,
  resolveAgentSurfaceEntry,
} from "@goat/contracts/agentSurface/resolve";
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

/**
 * Where a routed call ran, so the agent can tell remote results from local ones, and what to
 * call instead when the caller named the path by a deprecated name.
 */
const withMeta = (
  result: AgentSurfaceResult,
  meta: { readonly host?: string | undefined; readonly deprecated?: string | undefined },
): AgentSurfaceResult => ({
  ...result,
  ...(meta.host === undefined && meta.deprecated === undefined
    ? {}
    : {
        meta: {
          ...result.meta,
          ...(meta.host === undefined ? {} : { host: meta.host }),
          ...(meta.deprecated === undefined ? {} : { deprecated: meta.deprecated }),
        },
      }),
});

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
      name: listedToolName(entry),
      summary: entry.summary,
      effect: entry.effect,
      available: availability(entry, scope, dispatch.served(listedToolName(entry)) !== undefined),
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
        const tool = dispatch.served(listedToolName(entry));
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
      const name = listedToolName(entry);
      if (NOT_CALLABLE.has(entry.path))
        return envelopeError(
          "invalid_request",
          "not_callable",
          `${name} cannot run inside goat_call. Call it directly.`,
        );
      if (dispatch.served(name) === undefined)
        return envelopeError("not_found", "not_served", `This GOAT server does not serve ${name}.`);
      const captured = yield* Ref.make<unknown>(undefined);
      // Writes count as unkeyed until the registry says which ones the server deduplicates.
      const context: CallContext = { effect: entry.effect, pathOf };
      const args = input.args ?? {};
      const host = entry.hostRoutable && typeof args.host === "string" ? args.host : undefined;
      // The envelope names paths, so a deprecated name or path points at the current path.
      const deprecated = deprecatedReplacement(input.path) === undefined ? undefined : entry.path;
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
        Effect.map((result) => withMeta(result, { host })),
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
        Effect.map((result) => withMeta(result, { deprecated })),
      );
    });

    return {
      goat_describe: McpToolAccess.reads(describe),
      // Destructive so clients that prompt on destructive tools still prompt for the targets that are.
      goat_call: McpToolAccess.destructive(McpToolAccess.dispatches(call)),
    };
  }),
);
