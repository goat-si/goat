import type { agentSurfaceRegistry } from "./registry.ts";

/**
 * Writes that name a machine they act on outside a routing `host`. With goatclaw on, each named
 * machine needs `threads.remote` and a place in the profile's host allowlist, like a routed
 * `host`. A `host` that names something else, such as a git forge or the address of a machine
 * being added, is left out; agentSurface.test.ts checks every write's input against this list.
 */
const HOST_ARGUMENTS = {
  "channel.task_move": ["host"],
  "host.cordon": ["host"],
  "host.drain": ["host"],
  "host.uncordon": ["host"],
  "hub.device_join": ["deviceAlias"],
  "hub.device_leave": ["deviceAlias"],
  "hub.device_repair": ["deviceAlias"],
  "ssh.host_forget": ["host"],
  "ssh.host_prepare": ["host"],
  "ssh.runtime_update": ["host"],
  "thread.handoff_host": ["host", "destinationHost"],
  "thread.replication_set": ["host"],
  "thread.reschedule": ["host", "targetHost"],
} satisfies Partial<Record<keyof typeof agentSurfaceRegistry, ReadonlyArray<string>>>;

/** Every argument of a registered tool that names a machine the call reaches or acts on. */
export const hostArgumentsOf = (entry: {
  readonly path: string;
  readonly hostRoutable: boolean;
}): ReadonlyArray<string> => [
  ...(entry.hostRoutable ? ["host"] : []),
  ...((HOST_ARGUMENTS as Readonly<Record<string, ReadonlyArray<string>>>)[entry.path] ?? []),
];
