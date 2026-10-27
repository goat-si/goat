import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { RelayRateLimits } from "../accounts/RelayRateLimits.ts";
import * as ManagedProvisioningIntents from "./ManagedProvisioningIntents.ts";
import { policyUnitLayer, identityUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "goat-relay",
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: "t3code.test",
  managedEndpointNamespace: "dev_alex",
});

export interface TunnelCall {
  readonly operation: "get" | "list" | "create" | "putConfiguration" | "getToken" | "delete";
  readonly input: unknown;
}

export interface DnsCall {
  readonly operation: "listRecords" | "createRecord" | "updateRecord" | "deleteRecord";
  readonly input: unknown;
}

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

export function makeTunnelClient(calls: TunnelCall[] = []) {
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "get", input: tunnelId });
        return {
          id: tunnelId,
          name: "managed-tunnel",
          status: "down",
          connsInactiveAt: "2026-06-01T00:00:00.000Z",
        };
      }),
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: [] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        return { id: "tunnel-id", name: request.name };
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
    delete: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "delete", input: tunnelId });
      }),
  });
}

export function makePersistentTunnelClient(calls: TunnelCall[] = []) {
  let tunnel: { readonly id: string; readonly name: string } | null = null;
  return ManagedEndpointProvider.ManagedEndpointTunnelClient.of({
    get: (tunnelId) =>
      Effect.suspend(() => {
        calls.push({ operation: "get", input: tunnelId });
        return tunnel === null
          ? Effect.fail(
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "get",
                tunnelId,
                cause: { _tag: "NotFound" },
              }),
            )
          : Effect.succeed({
              ...tunnel,
              status: "down",
              connsInactiveAt: "2026-06-01T00:00:00.000Z",
            });
      }),
    list: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "list", input: request });
        return { result: tunnel === null ? [] : [tunnel] };
      }),
    create: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "create", input: request });
        tunnel = { id: "tunnel-id", name: request.name };
        return tunnel;
      }),
    putConfiguration: (tunnelId, tunnelConfig) =>
      Effect.sync(() => {
        calls.push({ operation: "putConfiguration", input: { tunnelId, tunnelConfig } });
      }),
    getToken: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "getToken", input: tunnelId });
        return "connector-token";
      }),
    delete: (tunnelId) =>
      Effect.sync(() => {
        calls.push({ operation: "delete", input: tunnelId });
        tunnel = null;
      }),
  });
}

export function makeDnsClient(
  calls: DnsCall[] = [],
  records: ReadonlyArray<{ readonly id: string }> = [],
) {
  let currentRecords = [...records];
  return ManagedEndpointProvider.ManagedEndpointDnsClient.of({
    listRecords: (hostname) =>
      Effect.sync(() => {
        calls.push({ operation: "listRecords", input: hostname });
        return currentRecords.map((r) => ({
          ...r,
          name: hostname,
          type: "CNAME",
          content: "tunnel-id.cfargotunnel.com",
        }));
      }),
    createRecord: (request) =>
      Effect.sync(() => {
        calls.push({ operation: "createRecord", input: request });
        const record = { id: "created-record-id" };
        currentRecords = [record];
        return record;
      }),
    updateRecord: (dnsRecordId, request) =>
      Effect.gen(function* () {
        calls.push({ operation: "updateRecord", input: { dnsRecordId, request } });
        if (!currentRecords.some((record) => record.id === dnsRecordId)) {
          return yield* new ManagedEndpointProvider.ManagedEndpointDnsClientError({
            operation: "update-record",
            hostname: request.name,
            dnsRecordId,
            cause: { _tag: "NotFound", dnsRecordId },
          });
        }
      }),
    deleteRecord: (dnsRecordId) =>
      Effect.sync(() => {
        calls.push({ operation: "deleteRecord", input: dnsRecordId });
        currentRecords = currentRecords.filter((record) => record.id !== dnsRecordId);
      }),
  });
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
          incarnationId: "10000000-0000-4000-8000-000000000001",
          accountEpoch: 1,
          endpointGeneration: 0,
          capacityReleasedAt: null,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
          origin: null,
          updatedAt: `generation-${++generation}`,
          generation: 0,
          tunnelReleasedAt: null,
        };
        allocations.set(allocationKey(input), allocation);
        return allocation;
      }),
    recordTunnel: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "recordTunnel", input });
        const current = allocations.get(allocationKey(input));
        if (current?.generation !== input.generation) {
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
        if (current?.generation !== input.generation || current.tunnelId !== input.tunnelId) {
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
        if (current?.generation !== input.generation || current.tunnelId !== input.tunnelId) {
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
          allocation.generation !== input.generation
        ) {
          return null;
        }
        mutate(allocationKey(input), (current) => current);
        return allocations.get(allocationKey(input))?.generation ?? null;
      }),
    withClaimedTunnel: (input, effect) =>
      Effect.suspend(() => {
        const current = allocations.get(allocationKey(input));
        return current?.tunnelId === input.tunnelId && current.generation === input.generation
          ? Effect.asSome(effect)
          : Effect.succeedNone;
      }),
    claimDeprovision: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "claimDeprovision", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation === undefined || allocation.generation !== input.generation) {
          return null;
        }
        mutate(allocationKey(input), (current) => current);
        return allocations.get(allocationKey(input))?.generation ?? null;
      }),
    markCapacityReleased: () => Effect.succeed(true),
    remove: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "remove", input });
        allocations.delete(allocationKey(input));
      }),
    removeClaimed: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "removeClaimed", input });
        const allocation = allocations.get(allocationKey(input));
        if (allocation === undefined || allocation.generation !== input.generation) {
          return false;
        }
        allocations.delete(allocationKey(input));
        return true;
      }),
  });
}

export function makeTunnelLimits(
  calls: Array<{ readonly userId: string; readonly environmentId: string }> = [],
  result: ManagedTunnelLimits.ManagedTunnelLimitExceeded | null = null,
) {
  return ManagedTunnelLimits.ManagedTunnelLimits.of({
    ensureCapacity: (input) =>
      Effect.suspend(() => {
        calls.push(input);
        return result === null ? Effect.void : Effect.fail(result);
      }),
  });
}

export function layerProvider(
  tunnelClient = makeTunnelClient(),
  dnsClient = makeDnsClient(),
  allocations = makeAllocations(),
  tunnelLimits = makeTunnelLimits(),
) {
  return ManagedEndpointProvider.layer.pipe(
    Layer.provide(policyUnitLayer),
    Layer.provide(identityUnitLayer(config)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClient)),
    Layer.provide(
      Layer.succeed(ManagedEndpointAllocations.ManagedEndpointAllocations, {
        ...allocations,
        reserve: (input) =>
          tunnelLimits.ensureCapacity(input).pipe(Effect.andThen(allocations.reserve(input))),
      }),
    ),
    Layer.provide(Layer.succeed(ManagedTunnelLimits.ManagedTunnelLimits, tunnelLimits)),
  );
}

const MANAGED_ENDPOINT_HASHES: Record<string, string> = {
  "user_ABC:env_ABC": "fe70a0e4f4b8eb87",
  "user_ABC:env_shared": "388b28a52f055d1a",
  "user_DEF:env_shared": "c416de8b81d55645",
};

function expectedManagedEndpointHash(environmentId: string, userId: string): string {
  const hash = MANAGED_ENDPOINT_HASHES[`${userId}:${environmentId}`];
  if (hash === undefined) throw new Error(`No pinned hash for ${userId}:${environmentId}`);
  return hash;
}

export function expectedManagedHostname(environmentId: string, userId = "user_ABC"): string {
  return `dev-alex-${expectedManagedEndpointHash(environmentId, userId)}.t3code.test`;
}

export function expectedManagedTunnelName(environmentId: string, userId = "user_ABC"): string {
  return `goatrelay-managedendpoint-dev-alex-${expectedManagedEndpointHash(environmentId, userId)}`;
}

export function layerPostgresProvider(
  pg: Parameters<typeof postgresPolicyLayer>[0],
  tunnelClient: ManagedEndpointProvider.ManagedEndpointTunnelClient["Service"],
  dnsClient: ManagedEndpointProvider.ManagedEndpointDnsClient["Service"],
  rates: RelayRateLimits["Service"] = { charge: () => Effect.void },
) {
  const policy = postgresPolicyLayer(pg);
  return ManagedEndpointProvider.layer.pipe(
    Layer.provide(ManagedEndpointProvider.layerTunnelClient(tunnelClient)),
    Layer.provide(ManagedEndpointProvider.layerDnsClient(dnsClient)),
    Layer.provide(ManagedProvisioningIntents.layer.pipe(Layer.provide(policy))),
    Layer.provide(Layer.succeed(RelayRateLimits, rates)),
    Layer.provideMerge(policy),
    Layer.provideMerge(NodeServices.layer),
  );
}
