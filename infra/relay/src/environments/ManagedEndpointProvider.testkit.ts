import * as Effect from "effect/Effect";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

export interface AllocationCall {
  readonly operation:
    | "get"
    | "reserve"
    | "recordTunnel"
    | "recordDns"
    | "markReady"
    | "claimRelease"
    | "claimDeprovision"
    | "remove"
    | "removeClaimed";
  readonly input: unknown;
}

function allocationKey(input: { readonly userId: string; readonly environmentId: string }) {
  return `${input.userId}:${input.environmentId}`;
}

export function makeAllocations(calls: AllocationCall[] = []) {
  const allocations = new Map<string, ManagedEndpointAllocations.ManagedEndpointAllocation>();
  const recoveryEnabled = new Set<string>();
  let generation = 0;
  const mutate = (
    key: string,
    change: (
      allocation: ManagedEndpointAllocations.ManagedEndpointAllocation,
    ) => ManagedEndpointAllocations.ManagedEndpointAllocation,
  ) => {
    const allocation = allocations.get(key);
    if (allocation !== undefined) {
      allocations.set(key, {
        ...change(allocation),
        generation: allocation.generation + 1,
        updatedAt: `generation-${++generation}`,
      });
    }
  };
  return ManagedEndpointAllocations.ManagedEndpointAllocations.of({
    getByTunnelName: () => Effect.die("unused getByTunnelName"),
    get: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "get", input });
        return allocations.get(allocationKey(input)) ?? null;
      }),
    reserve: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "reserve", input });
        const allocation = allocations.get(allocationKey(input)) ?? {
          ...input,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
          origin: null,
          updatedAt: `generation-${++generation}`,
          generation: 0,
          incarnationId: `allocation-${generation}`,
          tunnelReleasedAt: null,
        };
        allocations.set(allocationKey(input), allocation);
        return allocation;
      }),
    recordTunnel: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordTunnel", input });
        const current = allocations.get(allocationKey(input));
        if (
          current?.incarnationId !== input.incarnationId ||
          current.generation !== input.generation
        ) {
          return null;
        }
        mutate(allocationKey(input), (allocation) => ({
          ...allocation,
          tunnelId: input.tunnelId,
          readyAt: allocation.tunnelId === input.tunnelId ? allocation.readyAt : null,
        }));
        return allocations.get(allocationKey(input))?.generation ?? null;
      }),
    recordDns: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordDns", input });
        const current = allocations.get(allocationKey(input));
        if (
          current?.incarnationId !== input.incarnationId ||
          current.generation !== input.generation ||
          current.tunnelId !== input.tunnelId
        ) {
          return null;
        }
        mutate(allocationKey(input), (allocation) => ({
          ...allocation,
          dnsRecordId: input.dnsRecordId,
        }));
        return allocations.get(allocationKey(input))?.generation ?? null;
      }),
    markReady: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "markReady", input });
        const current = allocations.get(allocationKey(input));
        if (
          current?.incarnationId !== input.incarnationId ||
          current.generation !== input.generation ||
          current.tunnelId !== input.tunnelId
        ) {
          return false;
        }
        mutate(allocationKey(input), (allocation) => ({
          ...allocation,
          readyAt: "2026-06-02T00:00:00.000Z",
          origin: input.origin,
        }));
        return true;
      }),
    enableRecovery: (input) =>
      Effect.sync(() => {
        const allocation = allocations.get(allocationKey(input));
        if (allocation?.tunnelId !== input.tunnelId) {
          return false;
        }
        recoveryEnabled.add(allocationKey(input));
        return true;
      }),
    listByTunnelNames: (tunnelNames) =>
      Effect.sync(() =>
        [...allocations.values()]
          .filter((allocation) => tunnelNames.includes(allocation.tunnelName))
          .map((allocation) => ({
            ...allocation,
            recoveryEnabled: recoveryEnabled.has(allocationKey(allocation)),
          })),
      ),
    claimRelease: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "claimRelease", input });
        const allocation = allocations.get(allocationKey(input));
        if (
          allocation === undefined ||
          allocation.tunnelId !== input.tunnelId ||
          allocation.generation !== input.generation ||
          allocation.incarnationId !== input.incarnationId
        ) {
          return null;
        }
        mutate(allocationKey(input), (current) => current);
        return allocations.get(allocationKey(input))?.generation ?? null;
      }),
    withClaimedTunnel: (input, effect) =>
      Effect.suspend(() => {
        const current = allocations.get(allocationKey(input));
        return current?.incarnationId === input.incarnationId &&
          current.tunnelId === input.tunnelId &&
          current.generation === input.generation
          ? Effect.asSome(effect)
          : Effect.succeedNone;
      }),
    claimDeprovision: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "claimDeprovision", input });
        const allocation = allocations.get(allocationKey(input));
        if (
          allocation === undefined ||
          allocation.generation !== input.generation ||
          allocation.incarnationId !== input.incarnationId
        ) {
          return null;
        }
        mutate(allocationKey(input), (current) => current);
        return allocations.get(allocationKey(input))?.generation ?? null;
      }),
    remove: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "remove", input });
        allocations.delete(allocationKey(input));
      }),
    removeClaimed: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "removeClaimed", input });
        const allocation = allocations.get(allocationKey(input));
        if (
          allocation === undefined ||
          allocation.generation !== input.generation ||
          allocation.incarnationId !== input.incarnationId
        ) {
          return false;
        }
        allocations.delete(allocationKey(input));
        return true;
      }),
  });
}
