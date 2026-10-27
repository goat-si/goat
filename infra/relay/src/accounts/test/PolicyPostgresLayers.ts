import * as PgClient from "@effect/sql-pg/PgClient";
import * as Drizzle from "drizzle-orm/effect-postgres";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RelayDb } from "../../db.ts";
import * as RelayConfiguration from "../../Config.ts";
import * as AccountAccess from "../AccountAccess.ts";
import * as AccountTransactions from "../AccountTransactions.ts";
import * as AccountLimits from "../AccountLimits.ts";
import * as AccountDeviceAdmission from "../AccountDeviceAdmission.ts";
import * as AccountLifecycle from "../AccountLifecycle.ts";
import * as EnvironmentOwnership from "../../environments/EnvironmentOwnership.ts";
import * as EndpointIdentity from "../../environments/EndpointIdentity.ts";
import * as ManagedEndpointAllocations from "../../environments/ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "../../environments/ManagedTunnelLimits.ts";
import * as EnvironmentLinks from "../../environments/EnvironmentLinks.ts";
import * as EnvironmentCredentials from "../../environments/EnvironmentCredentials.ts";
import * as Devices from "../../agentActivity/Devices.ts";
import * as LiveActivities from "../../agentActivity/LiveActivities.ts";
import * as DeliveryAuthorization from "../../agentActivity/DeliveryAuthorization.ts";
import * as HookDeliveryAuthorization from "../../hooks/HookDeliveryAuthorization.ts";
import * as HookInbox from "../../hooks/HookInbox.ts";
import type { createPostgresFixture } from "./PostgresFixture.ts";

export const testConfig: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("fixture-clerk"),
  clerkPublishableKey: "fixture-publishable",
  clerkJwtAudience: "fixture-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("fixture-job-signing"),
  cloudMintPrivateKey: Redacted.make("unused-local-fixture-key"),
  cloudMintPublicKey: "unused-local-fixture-public-key",
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: "test_stage",
};

export function postgresPolicyLayer(
  pg: ReturnType<typeof createPostgresFixture>,
  options?: {
    readonly config?: RelayConfiguration.RelayConfiguration["Service"];
    readonly limits?: Partial<AccountLimits.Limits>;
    readonly clear?: HookInbox.HookInbox["Service"]["clear"];
  },
) {
  const database = Layer.effect(RelayDb, Drizzle.makeWithDefaults()).pipe(
    Layer.provide(
      PgClient.layer({
        host: pg.socket,
        username: "relay_test",
        database: "postgres",
        prepare: false,
        maxConnections: 8,
      }),
    ),
  );
  return Layer.empty.pipe(
    Layer.provideMerge(AccountLifecycle.layer),
    Layer.provideMerge(EnvironmentCredentials.layer),
    Layer.provideMerge(EnvironmentLinks.layer),
    Layer.provideMerge(Devices.layer),
    Layer.provideMerge(LiveActivities.layer),
    Layer.provideMerge(ManagedEndpointAllocations.layer),
    Layer.provideMerge(ManagedTunnelLimits.layer),
    Layer.provideMerge(EndpointIdentity.layer),
    Layer.provideMerge(EnvironmentOwnership.layer),
    Layer.provideMerge(AccountDeviceAdmission.layer),
    Layer.provideMerge(DeliveryAuthorization.layer),
    Layer.provideMerge(HookDeliveryAuthorization.layer),
    Layer.provideMerge(AccountAccess.layer),
    Layer.provideMerge(AccountTransactions.layer),
    Layer.provideMerge(
      Layer.succeed(HookInbox.HookInbox, {
        hold: Effect.fn("HookInbox.HookInbox.hold")(function* () {
          return yield* Effect.die("No network in PostgreSQL fixtures");
        }),
        wake: Effect.fn("HookInbox.HookInbox.wake")(function* () {
          return yield* Effect.die("No network in PostgreSQL fixtures");
        }),
        clear: options?.clear ?? Effect.fn("HookInbox.HookInbox.clear")(function* () {}),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(AccountLimits.AccountLimits, {
        ...AccountLimits.DEFAULT_LIMITS,
        ...options?.limits,
      }),
    ),
    Layer.provideMerge(RelayConfiguration.layer(options?.config ?? testConfig)),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeCrypto.layer),
  );
}
