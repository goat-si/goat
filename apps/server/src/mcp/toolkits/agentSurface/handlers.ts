import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import { canonicalToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { makeOperationTokens } from "../../operations/OperationTokens.ts";
import { ToolDispatch } from "../../ToolDispatch.ts";
import { dispatchEnvelope, envelopeError } from "./dispatchEnvelope.ts";
import { makeOperations } from "./operations.ts";
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

export const layer = McpToolAccess.toLayer(
  AgentSurfaceToolkit,
  Effect.gen(function* () {
    const dispatch = yield* ToolDispatch;
    const operations = makeOperations(dispatch, yield* makeOperationTokens);

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
      const args = input.args ?? {};
      const host = entry.hostRoutable && typeof args.host === "string" ? args.host : undefined;
      // Work that runs on needs a handle; without one, starting it would strand the caller (D1).
      if (yield* operations.unready(entry))
        return {
          status: "error",
          error: {
            code: "unavailable",
            reason: "operation_unavailable",
            message: `GOAT could not prepare a handle for this work, so ${entry.name} did not run. Try again.`,
            retryable: true,
          },
        } satisfies AgentSurfaceResult;
      const result = yield* dispatchEnvelope(dispatch, entry.name, args, entry.effect, host);
      return yield* operations.withOperation(entry, result);
    });

    return {
      goat_describe: McpToolAccess.reads(describe),
      // Destructive so clients that prompt on destructive tools still prompt for the targets that are.
      goat_call: McpToolAccess.destructive(McpToolAccess.dispatches(call)),
      goat_operation_read: McpToolAccess.reads(operations.read),
      goat_operation_wait: McpToolAccess.reads(operations.wait),
      // The kind's own cancel tool holds the checks, as goat_call's targets do.
      goat_operation_cancel: McpToolAccess.destructive(McpToolAccess.dispatches(operations.cancel)),
    };
  }),
);
