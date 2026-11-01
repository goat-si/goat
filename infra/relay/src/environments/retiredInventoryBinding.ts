import { RelayConfiguration } from "../Config.ts";
import { managedEndpointTunnelNamePrefix } from "../deploymentConfig.ts";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Cloudflare from "alchemy/Cloudflare";
import type * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  RetiredEndpointInventory,
  RetiredInventoryError,
  INVENTORY_PAGE_SIZE,
} from "./RetiredEndpointCollector.ts";
import { makeCloudflareApiGate } from "./CloudflareRuntimeApi.ts";
import { isManagedEndpointNotFound } from "./managedEndpointOrigin.ts";
import { CloudflareApiPause } from "./CloudflareApiPause.ts";

export const layer = (
  tunnels: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dns: Cloudflare.DNS.ReadWriteDnsClient,
  auth: Cloudflare.Tunnel.TunnelAuth,
  runtime: Alchemy.BaseRuntimeContext,
) =>
  Layer.effect(
    RetiredEndpointInventory,
    Effect.gen(function* () {
      const config = yield* RelayConfiguration;
      if (!config.managedEndpointNamespace)
        return yield* Effect.die(new Error("Retired inventory requires the deployed relay stage"));
      const prefix = managedEndpointTunnelNamePrefix(config.managedEndpointNamespace);
      const pause = yield* CloudflareApiPause;
      const gate = makeCloudflareApiGate(runtime)(pause);
      const mutate = <A, E>(
        operation: string,
        effect: Effect.Effect<A, E, Alchemy.RuntimeContext>,
      ) =>
        gate(effect).pipe(
          Effect.asVoid,
          Effect.catchIf(isManagedEndpointNotFound, () => Effect.void),
          Effect.mapError((cause) => new RetiredInventoryError({ operation, cause })),
        );
      return RetiredEndpointInventory.of({
        tunnels: Effect.fn("RetiredEndpointInventory.tunnels")((page) =>
          gate(
            tunnels.list({ name: prefix, page, perPage: INVENTORY_PAGE_SIZE, isDeleted: false }),
          ).pipe(
            Effect.map((r) => r.result.map((t) => ({ id: t.id ?? "", name: t.name ?? "" }))),
            Effect.mapError(
              (cause) => new RetiredInventoryError({ operation: "list-tunnels", cause }),
            ),
          ),
        ),
        dns: Effect.fn("RetiredEndpointInventory.dns")((page) =>
          gate(dns.listDnsRecords({ page, perPage: INVENTORY_PAGE_SIZE })).pipe(
            Effect.map((r) => r.result.map((t) => ({ id: t.id, name: t.name }))),
            Effect.mapError((cause) => new RetiredInventoryError({ operation: "list-dns", cause })),
          ),
        ),
        disconnect: Effect.fn("RetiredEndpointInventory.disconnect")((id) =>
          mutate(
            "disconnect",
            Effect.gen(function* () {
              const accountId = yield* auth.accountId;
              return yield* auth.authorize(
                zeroTrust.deleteTunnelCloudflaredConnection({ accountId, tunnelId: id }),
              );
            }),
          ),
        ),
        deleteTunnel: Effect.fn("RetiredEndpointInventory.deleteTunnel")((id) =>
          mutate("delete-tunnel", tunnels.delete(id)),
        ),
        deleteDns: Effect.fn("RetiredEndpointInventory.deleteDns")((id) =>
          mutate("delete-dns", dns.deleteDnsRecord(id)),
        ),
      });
    }),
  );
