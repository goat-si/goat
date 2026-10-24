import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import * as Effect from "effect/Effect";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";

export interface Availability {
  readonly now: boolean;
  readonly reason?: string;
}

/** A thread caller's goatclaw profile as its calls resolve it, or why it does not resolve. */
export type CallerProfile =
  | { readonly resolved: true; readonly effective: Profiles.EffectiveProfile }
  | { readonly resolved: false; readonly reason: string };

/**
 * The profile a call from this caller would be held to. Outside clients have none: the call gate
 * bounds them by their approved access alone.
 */
export const callerProfile = Effect.fn("toolAvailability.callerProfile")(function* (
  permissions: Profiles.PermissionProfiles["Service"],
  scope: McpInvocationContext.McpInvocationScope,
) {
  if (scope.thread === undefined) return undefined;
  return yield* permissions.resolve(scope).pipe(
    Effect.match({
      onFailure: (failure): CallerProfile => ({ resolved: false, reason: failure.message }),
      onSuccess: (effective): CallerProfile => ({ resolved: true, effective }),
    }),
  );
});

/**
 * What McpToolAccess.requireDeclaredCapability refuses before arguments are read. A write that
 * declares `none` can still be refused for a host it names; that depends on the call's arguments.
 */
const profileRefusal = (entry: AgentSurfaceEntry, profile: CallerProfile) => {
  if (entry.effect === "read" || entry.capability === "none") return undefined;
  if (!profile.resolved) return profile.reason;
  if (!profile.effective.enabled) return undefined;
  if (entry.capability === undefined) return "It declares no goatclaw capability.";
  const checked = Profiles.checkProfile(profile.effective, entry.capability, {});
  return checked.ok
    ? undefined
    : `Needs the goatclaw ${entry.capability} capability. ${checked.reason}`;
};

/**
 * The refusals this server is sure of before a call, for goat_describe and the listing, the
 * caller's goatclaw profile included when one is passed. Handlers still run every other check,
 * such as a host allowlist or a lane limit, when the call is made.
 */
export const availability = (
  entry: AgentSurfaceEntry,
  scope: McpInvocationContext.McpInvocationScope,
  served: boolean,
  profile?: CallerProfile,
): Availability => {
  if (!served) return { now: false, reason: "This GOAT server does not serve it." };
  if (entry.resource === "surface") return { now: true };
  if (entry.requires === "thread" && scope.thread === undefined)
    return { now: false, reason: "Needs an agent running inside a GOAT thread." };
  if (entry.requires === "client" && scope.thread !== undefined)
    return { now: false, reason: "Only an outside MCP client can call it." };
  if (entry.effect !== "read" && scope.client?.access === "read-only")
    return { now: false, reason: "This MCP client was approved for read-only access." };
  const refusal = profile === undefined ? undefined : profileRefusal(entry, profile);
  return refusal === undefined ? { now: true } : { now: false, reason: refusal };
};
