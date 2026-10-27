import * as Effect from "effect/Effect";
import * as Provider from "./ManagedEndpointProvider.ts";

export const removeResources = Effect.fn("ManagedEndpointCleanup.removeResources")(function* (
  target: Provider.ManagedEndpointDeprovisionTarget,
) {
  const dns = yield* Provider.ManagedEndpointDnsClient;
  const tunnels = yield* Provider.ManagedEndpointTunnelClient;
  const failure = (stage: "delete-dns-record" | "delete-tunnel", cause: unknown) =>
    new Provider.ManagedEndpointDeprovisioningFailed({
      userId: target.userId,
      environmentId: target.environmentId,
      stage,
      cause,
    });
  // Provider writes can succeed before their database checkpoint; discover by the reserved identity.
  const records =
    target.dnsRecordId === null
      ? yield* dns
          .listRecords(target.hostname)
          .pipe(Effect.mapError((cause) => failure("delete-dns-record", cause)))
      : [{ id: target.dnsRecordId }];
  for (const record of records) {
    yield* dns.deleteRecord(record.id).pipe(
      Effect.catchTags({
        ManagedEndpointDnsClientError: (error) =>
          Provider.isManagedEndpointNotFound(error.cause) ? Effect.void : Effect.fail(error),
      }),
      Effect.mapError((cause) => failure("delete-dns-record", cause)),
    );
  }
  const candidates =
    target.tunnelId === null
      ? (yield* tunnels
          .list({ name: target.tunnelName, isDeleted: false })
          .pipe(Effect.mapError((cause) => failure("delete-tunnel", cause)))).result.filter(
          (tunnel) => tunnel.name === target.tunnelName,
        )
      : [{ id: target.tunnelId }];
  for (const tunnel of candidates) {
    if (!tunnel.id) return yield* failure("delete-tunnel", "missing tunnel identity");
    yield* tunnels.delete(tunnel.id).pipe(
      Effect.catchTags({
        ManagedEndpointTunnelClientError: (error) =>
          Provider.isManagedEndpointNotFound(error.cause) ? Effect.void : Effect.fail(error),
      }),
      Effect.mapError((cause) => failure("delete-tunnel", cause)),
    );
  }
});
