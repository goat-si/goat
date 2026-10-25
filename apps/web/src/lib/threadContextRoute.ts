import { connectionRoutes, type ConnectionCatalogEntry } from "@goat/client-runtime/connection";
import type { EnvironmentId, ThreadContextRecord } from "@goat/contracts";
import * as Option from "effect/Option";

/**
 * How the agent of one environment reaches a thread attached as context.
 *
 * The thread tools route by SSH alias (`goat_thread_read({ threadId, host })`), and the
 * agent's server resolves that alias with its own SSH config. The only aliases this client
 * knows are the ones on its saved SSH connections, which the desktop app resolved with the
 * SSH config of the machine it runs on. So a saved alias is meaningful to exactly one
 * server: the desktop app's own primary backend, which runs on that machine as the same user.
 * Anything else (a browser, a remote agent, a WSL or GOAT Connect environment) has no alias
 * this client can vouch for, and the attachment is refused with the reason.
 */
export type ThreadContextRoute =
  | { readonly kind: "local" }
  | { readonly kind: "ssh"; readonly host: string }
  | { readonly kind: "unreachable"; readonly reason: ThreadContextUnreachableReason };

export type ThreadContextUnreachableReason =
  /** The agent's server is not the desktop app's own backend, so it shares no SSH config. */
  | "agent-not-on-this-device"
  /** The thread's environment is saved without an SSH connection (GOAT Connect or a URL only). */
  | "no-ssh-connection"
  /** The thread's environment is not saved on this client anymore. */
  | "unknown-environment";

export function resolveThreadContextRoute(input: {
  readonly agentEnvironmentId: EnvironmentId;
  readonly threadEnvironmentId: EnvironmentId;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly isDesktopRenderer: boolean;
}): ThreadContextRoute {
  if (input.threadEnvironmentId === input.agentEnvironmentId) return { kind: "local" };
  const agentEntry = input.entries.get(input.agentEnvironmentId);
  if (!input.isDesktopRenderer || agentEntry?.target._tag !== "PrimaryConnectionTarget") {
    return { kind: "unreachable", reason: "agent-not-on-this-device" };
  }
  const threadEntry = input.entries.get(input.threadEnvironmentId);
  if (threadEntry === undefined) return { kind: "unreachable", reason: "unknown-environment" };
  for (const route of connectionRoutes(threadEntry)) {
    const profile = Option.getOrNull(route.profile);
    const alias = profile?._tag === "SshConnectionProfile" ? profile.target.alias.trim() : "";
    if (alias.length > 0) return { kind: "ssh", host: alias };
  }
  return { kind: "unreachable", reason: "no-ssh-connection" };
}

/** The record as the agent should see it: `host` set for another environment, absent for its own. */
export function routeThreadContextRecord(
  record: ThreadContextRecord,
  route: Exclude<ThreadContextRoute, { readonly kind: "unreachable" }>,
): ThreadContextRecord {
  const { host: _previous, ...rest } = record;
  return route.kind === "ssh" ? { ...rest, host: route.host } : rest;
}

/**
 * Routes a batch of attachments for one agent. Reachable records come back with their host
 * settled; the first refusal becomes the message to show, so a mixed drop attaches what it can.
 */
export function routeThreadContextRecords(input: {
  readonly records: ReadonlyArray<ThreadContextRecord>;
  readonly agentEnvironmentId: EnvironmentId;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly isDesktopRenderer: boolean;
}): {
  readonly routed: ReadonlyArray<ThreadContextRecord>;
  readonly refusal: { readonly title: string; readonly description: string } | null;
} {
  const routed: ThreadContextRecord[] = [];
  let refusal: { readonly title: string; readonly description: string } | null = null;
  for (const record of input.records) {
    const route = resolveThreadContextRoute({
      agentEnvironmentId: input.agentEnvironmentId,
      threadEnvironmentId: record.environmentId,
      entries: input.entries,
      isDesktopRenderer: input.isDesktopRenderer,
    });
    if (route.kind !== "unreachable") {
      routed.push(routeThreadContextRecord(record, route));
      continue;
    }
    refusal ??= threadContextUnreachableMessage({
      reason: route.reason,
      threadEnvironmentLabel: input.entries.get(record.environmentId)?.target.label ?? null,
      agentEnvironmentLabel: input.entries.get(input.agentEnvironmentId)?.target.label ?? null,
    });
  }
  return { routed, refusal };
}

/**
 * Re-settles hosts at send time for the environment that actually receives the message: a
 * draft can move to another environment after its threads were attached. A thread this agent
 * cannot reach keeps its identity but loses a host that was meant for another agent.
 */
export function settleThreadContextsForAgent(input: {
  readonly records: ReadonlyArray<ThreadContextRecord>;
  readonly agentEnvironmentId: EnvironmentId;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly isDesktopRenderer: boolean;
}): ReadonlyArray<ThreadContextRecord> {
  return input.records.map((record) => {
    const route = resolveThreadContextRoute({
      agentEnvironmentId: input.agentEnvironmentId,
      threadEnvironmentId: record.environmentId,
      entries: input.entries,
      isDesktopRenderer: input.isDesktopRenderer,
    });
    return routeThreadContextRecord(
      record,
      route.kind === "unreachable" ? { kind: "local" } : route,
    );
  });
}

/** Toast copy for a refused attachment; labels are the user's names for the environments. */
function threadContextUnreachableMessage(input: {
  readonly reason: ThreadContextUnreachableReason;
  readonly threadEnvironmentLabel: string | null;
  readonly agentEnvironmentLabel: string | null;
}): { readonly title: string; readonly description: string } {
  const threadPlace = input.threadEnvironmentLabel ?? "another environment";
  const agentPlace = input.agentEnvironmentLabel ?? "this environment";
  switch (input.reason) {
    case "agent-not-on-this-device":
      return {
        title: `Can't attach threads from ${threadPlace} here`,
        description: `This agent runs on ${agentPlace}, which can only read its own threads. Threads from SSH hosts can be attached to threads that run on this computer in the desktop app.`,
      };
    case "no-ssh-connection":
      return {
        title: `Can't reach ${threadPlace} from this agent`,
        description: `${threadPlace} is connected without SSH, and the agent reads other machines' threads over SSH. Add an SSH connection for it in Settings → Connections to attach its threads.`,
      };
    case "unknown-environment":
      return {
        title: "Thread environment unavailable",
        description: "That thread's environment is no longer saved on this device.",
      };
  }
}
