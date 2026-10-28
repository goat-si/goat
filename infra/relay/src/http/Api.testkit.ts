import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";
import { EnvironmentOwnership } from "../environments/EnvironmentOwnership.ts";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as ConnectLinkReservations from "../environments/ConnectLinkReservations.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import { RelayEnvironmentLinkRequest } from "@goat/contracts/relay";
import { RelayEnvironmentLinkUnavailableError } from "@goat/contracts/relay";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import { createClerkClient, verifyToken } from "@clerk/backend";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

export const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
  clerkAuthorizedParties: ["https://app.example.test"],
  clerkCliOAuthClientId: "cli-client",
  clerkJwtAudience: "https://relay.example.test",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

export const encodeLinkRequest = Schema.encodeEffect(
  Schema.fromJsonString(RelayEnvironmentLinkRequest),
);
export const decodeLinkUnavailableError = Schema.decodeUnknownEffect(
  RelayEnvironmentLinkUnavailableError,
);

export function layerRelayUnlinkTest(input?: {
  readonly withTransaction?: RelayDb.RelayTransactions["Service"]["withTransaction"];
  readonly getForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["getForUser"];
  readonly revokeForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["revokeForUser"];
  readonly revokeCredential?: EnvironmentCredentials.EnvironmentCredentials["Service"]["revokeForEnvironmentPublicKey"];
  readonly prepareDeprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["prepareDeprovision"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
  readonly provision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["provision"];
  readonly reconcileOrigin?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["reconcileOrigin"];
  readonly release?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["release"];
  readonly clearInbox?: HookInbox.HookInbox["Service"]["clear"];
  readonly finishRelease?: EnvironmentOwnership["Service"]["finishRelease"];
}) {
  return Layer.mergeAll(
    policyUnitLayer,
    Layer.mock(ConnectLinkReservations.ConnectLinkReservations, {
      exclusive: (_userId, use) => use(Effect.void),
      withdraw: (_input, revoke) => revoke,
    }),
    Layer.succeed(EnvironmentOwnership, {
      beginRelease: () => Effect.succeed([]),
      finishRelease: input?.finishRelease ?? (() => Effect.succeed(true)),
      claim: () => Effect.void,
      assertActive: () => Effect.void,
    }),
    Layer.succeed(AccountTransactions, {
      run: (_input, effect) => (input?.withTransaction ? input.withTransaction(effect) : effect),
    }),
    Layer.mock(HookInbox.HookInbox, {
      clear: input?.clearInbox ?? (() => Effect.void),
    }),
    Layer.succeed(
      RelayDb.RelayTransactions,
      RelayDb.RelayTransactions.of({
        withTransaction: input?.withTransaction ?? ((effect) => effect),
      }),
    ),
    Layer.succeed(
      EnvironmentLinks.EnvironmentLinks,
      EnvironmentLinks.EnvironmentLinks.of({
        upsert: () => Effect.die("unused upsert"),
        listDeliveryUsersForEnvironment: () => Effect.die("unused listDeliveryUsersForEnvironment"),
        listForUser: () => Effect.die("unused listForUser"),
        getForUser: input?.getForUser ?? (() => Effect.succeed(null)),
        findActiveManagedForEnvironment: () => Effect.die("unused findActiveManagedForEnvironment"),
        setHoldWebhooksWhileOffline: () => Effect.die("unused setHoldWebhooksWhileOffline"),
        revokeForUser: input?.revokeForUser ?? (() => Effect.succeed(false)),
      }),
    ),
    Layer.succeed(
      EnvironmentCredentials.EnvironmentCredentials,
      EnvironmentCredentials.EnvironmentCredentials.of({
        create: () => Effect.die("unused create"),
        authenticate: () => Effect.die("unused authenticate"),
        revokeForEnvironmentPublicKey: input?.revokeCredential ?? (() => Effect.succeed(false)),
      }),
    ),
    Layer.succeed(
      ManagedEndpointProvider.ManagedEndpointProvider,
      ManagedEndpointProvider.ManagedEndpointProvider.of({
        provision: input?.provision ?? (() => Effect.die("unused provision")),
        reconcileOrigin: input?.reconcileOrigin ?? (() => Effect.succeed("ready")),
        prepareDeprovision: input?.prepareDeprovision ?? (() => Effect.succeed(null)),
        deprovision: input?.deprovision ?? (() => Effect.succeed(true)),
        release: input?.release ?? (() => Effect.die("unused release")),
      }),
    ),
  );
}
