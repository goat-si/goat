import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";

import type * as McpInvocationContext from "./McpInvocationContext.ts";

export interface Availability {
  readonly now: boolean;
  readonly reason?: string;
}

/**
 * The refusals this server is sure of before a call, for goat_describe and the listing. Handlers
 * still run every other check, goatclaw profiles included, when the call is made.
 */
export const availability = (
  entry: AgentSurfaceEntry,
  scope: McpInvocationContext.McpInvocationScope,
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
