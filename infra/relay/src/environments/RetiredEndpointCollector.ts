import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";

export const INVENTORY_PAGE_SIZE = 5;
export class RetiredInventoryError extends Schema.TaggedError<RetiredInventoryError>()(
  "RetiredInventoryError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
export class RetiredEndpointInventory extends Context.Service<
  RetiredEndpointInventory,
  {
    readonly tunnels: (
      page: number,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string }>,
      RetiredInventoryError
    >;
    readonly dns: (
      page: number,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string }>,
      RetiredInventoryError
    >;
    readonly disconnect: (id: string) => Effect.Effect<void, RetiredInventoryError>;
    readonly deleteTunnel: (id: string) => Effect.Effect<void, RetiredInventoryError>;
    readonly deleteDns: (id: string) => Effect.Effect<void, RetiredInventoryError>;
  }
>()("goat-relay/environments/RetiredEndpointCollector/RetiredEndpointInventory") {}
export class RetiredEndpointCollector extends Context.Service<
  RetiredEndpointCollector,
  {
    readonly sweep: Effect.Effect<void, RetiredInventoryError>;
  }
>()("goat-relay/environments/RetiredEndpointCollector") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const sql = db.$client;
  const config = yield* RelayConfiguration;
  const tx = yield* AccountTransactions;
  const crypto = yield* Crypto.Crypto;
  const inventory = yield* RetiredEndpointInventory;
  return RetiredEndpointCollector.of({
    sweep: Effect.gen(function* () {
      const stage = config.managedEndpointNamespace;
      if (!stage) return;
      const owner = yield* crypto
        .randomUUIDv4()
        .pipe(
          Effect.mapError((cause) => new RetiredInventoryError({ operation: "lease-id", cause })),
        );
      const claim = yield* tx
        .run(
          { userIds: [`retired-collector:${stage}`] },
          Effect.gen(function* () {
            yield* sql`INSERT INTO relay_retired_collector_state(stage) VALUES (${stage}) ON CONFLICT DO NOTHING`;
            const [row] = yield* sql<{
              tunnel_page: number;
              dns_page: number;
              tunnel_cycle: number;
              dns_cycle: number;
            }>`UPDATE relay_retired_collector_state SET lease_owner=${owner},lease_expires_at=now()+interval '20 minutes' WHERE stage=${stage} AND (lease_expires_at IS NULL OR lease_expires_at<now()) RETURNING tunnel_page,dns_page,tunnel_cycle,dns_cycle`;
            return row;
          }),
        )
        .pipe(Effect.mapError((cause) => new RetiredInventoryError({ operation: "claim", cause })));
      if (!claim) return;
      yield* Effect.gen(function* () {
        const [tunnels, dns] = yield* Effect.all([
          inventory.tunnels(claim.tunnel_page),
          inventory.dns(claim.dns_page),
        ]);
        const retired = yield* sql<{
          tunnel_name: string;
          hostname: string;
        }>`SELECT tunnel_name,hostname FROM relay_retired_endpoints WHERE stage=${stage} AND (${sql.in(
          "tunnel_name",
          tunnels.map((t) => t.name),
        )} OR ${sql.in(
          "hostname",
          dns.map((r) => r.name),
        )})`.pipe(
          Effect.mapError((cause) => new RetiredInventoryError({ operation: "lookup", cause })),
        );
        const names = new Set(retired.map((r) => r.tunnel_name));
        const hosts = new Set(retired.map((r) => r.hostname));
        const reconcile = Effect.fn("RetiredEndpointCollector.reconcile")(function* (
          kind: "tunnel" | "dns",
          id: string,
          cycle: number,
          remove: Effect.Effect<void, RetiredInventoryError>,
        ) {
          yield* sql`INSERT INTO relay_retired_inventory_backlog(stage,kind,resource_id,last_seen_cycle) VALUES (${stage},${kind},${id},${cycle}) ON CONFLICT(stage,kind,resource_id) DO UPDATE SET last_seen_cycle=excluded.last_seen_cycle`.pipe(
            Effect.mapError((cause) => new RetiredInventoryError({ operation: "backlog", cause })),
          );
          const result = yield* remove.pipe(Effect.result);
          if (result._tag === "Success")
            yield* sql`DELETE FROM relay_retired_inventory_backlog WHERE stage=${stage} AND kind=${kind} AND resource_id=${id}`.pipe(
              Effect.mapError(
                (cause) => new RetiredInventoryError({ operation: "backlog", cause }),
              ),
            );
          else
            yield* Effect.logWarning("Retired resource cleanup will retry", {
              operation: result.failure.operation,
            });
        });
        for (const tunnel of tunnels)
          if (names.has(tunnel.name))
            yield* reconcile(
              "tunnel",
              tunnel.id,
              claim.tunnel_cycle,
              inventory
                .disconnect(tunnel.id)
                .pipe(Effect.andThen(inventory.deleteTunnel(tunnel.id))),
            );
        for (const record of dns)
          if (hosts.has(record.name))
            yield* reconcile("dns", record.id, claim.dns_cycle, inventory.deleteDns(record.id));
        const tunnelEnd = tunnels.length < INVENTORY_PAGE_SIZE;
        const dnsEnd = dns.length < INVENTORY_PAGE_SIZE;
        if (tunnelEnd)
          yield* sql`DELETE FROM relay_retired_inventory_backlog WHERE stage=${stage} AND kind='tunnel' AND last_seen_cycle<${claim.tunnel_cycle}`.pipe(
            Effect.mapError((cause) => new RetiredInventoryError({ operation: "backlog", cause })),
          );
        if (dnsEnd)
          yield* sql`DELETE FROM relay_retired_inventory_backlog WHERE stage=${stage} AND kind='dns' AND last_seen_cycle<${claim.dns_cycle}`.pipe(
            Effect.mapError((cause) => new RetiredInventoryError({ operation: "backlog", cause })),
          );
        const [backlog] = yield* sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM relay_retired_inventory_backlog WHERE stage=${stage}`.pipe(
          Effect.mapError((cause) => new RetiredInventoryError({ operation: "backlog", cause })),
        );
        yield* sql`UPDATE relay_retired_collector_state SET tunnel_page=${tunnelEnd ? 1 : claim.tunnel_page + 1},dns_page=${dnsEnd ? 1 : claim.dns_page + 1},tunnel_cycle=${claim.tunnel_cycle + (tunnelEnd ? 1 : 0)},dns_cycle=${claim.dns_cycle + (dnsEnd ? 1 : 0)},observed_backlog=${backlog?.count ?? 0} WHERE stage=${stage} AND lease_owner=${owner}`.pipe(
          Effect.mapError((cause) => new RetiredInventoryError({ operation: "cursor", cause })),
        );
        yield* Effect.annotateCurrentSpan({
          "relay.retired.observed_backlog": backlog?.count ?? 0,
        });
      }).pipe(
        Effect.ensuring(
          sql`UPDATE relay_retired_collector_state SET lease_owner=NULL,lease_expires_at=NULL WHERE stage=${stage} AND lease_owner=${owner}`.pipe(
            Effect.orDie,
          ),
        ),
      );
    }).pipe(Effect.withSpan("relay.retired_endpoint_collector.sweep")),
  });
});
export const layer = Layer.effect(RetiredEndpointCollector, make);
