// @effect-diagnostics nodeBuiltinImport:off -- Pure crypto and provider unit fixtures use deterministic synthetic account policy.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AccountAccess } from "../AccountAccess.ts";
import { AccountTransactions } from "../AccountTransactions.ts";
import { AccountDeviceAdmission } from "../AccountDeviceAdmission.ts";
import { RelayRateLimits } from "../RelayRateLimits.ts";
import { AccountLimits, DEFAULT_LIMITS } from "../AccountLimits.ts";
import { EnvironmentOwnership } from "../../environments/EnvironmentOwnership.ts";
import { EndpointIdentity } from "../../environments/EndpointIdentity.ts";
import { ManagedProvisioningIntents } from "../../environments/ManagedProvisioningIntents.ts";
import { ManagedTunnelLimits } from "../../environments/ManagedTunnelLimits.ts";
import { DeliveryAuthorization } from "../../agentActivity/DeliveryAuthorization.ts";
import { HookDeliveryAuthorization } from "../../hooks/HookDeliveryAuthorization.ts";
import {
  managedEndpointDigestInput,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../../deploymentConfig.ts";
import type { RelayConfiguration } from "../../Config.ts";

export const policyUnitLayer = Layer.mergeAll(
  Layer.succeed(AccountAccess, {
    admit: Effect.fn("AccountAccess.admit")(function* (userId) {
      return { userId, accountEpoch: 1 };
    }),
    capture: Effect.fn("AccountAccess.capture")(function* (userId) {
      return { userId, accountEpoch: 1 };
    }),
    requireAllowed: Effect.fn("AccountAccess.requireAllowed")(function* (input) {
      return { userId: input.userId, accountEpoch: 1 };
    }),
  }),
  Layer.succeed(AccountTransactions, {
    run: Effect.fn("AccountTransactions.run")(function* <A, E, R>(
      _input: Parameters<AccountTransactions["Service"]["run"]>[0],
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* effect;
    }),
  }),
  Layer.succeed(RelayRateLimits, {
    charge: Effect.fn("RelayRateLimits.charge")(function* () {}),
  }),
  Layer.succeed(AccountLimits, DEFAULT_LIMITS),
  Layer.succeed(EnvironmentOwnership, {
    beginRelease: Effect.fn("EnvironmentOwnership.beginRelease")(function* () {
      return [];
    }),
    finishRelease: Effect.fn("EnvironmentOwnership.finishRelease")(function* () {
      return true;
    }),
    claim: Effect.fn("EnvironmentOwnership.claim")(function* () {}),
    assertActive: Effect.fn("EnvironmentOwnership.assertActive")(function* () {}),
  }),
  Layer.succeed(AccountDeviceAdmission, {
    write: Effect.fn("AccountDeviceAdmission.write")(function* <A, E, R>(
      _input: Parameters<AccountDeviceAdmission["Service"]["write"]>[0],
      body: (epoch: number) => Effect.Effect<A, E, R>,
    ) {
      return yield* body(1);
    }),
    unregister: Effect.fn("AccountDeviceAdmission.unregister")(function* <A, E, R>(
      _userId: string,
      body: Effect.Effect<A, E, R>,
    ) {
      return yield* body;
    }),
  }),
  Layer.succeed(ManagedProvisioningIntents, {
    prepare: Effect.fn("ManagedProvisioningIntents.prepare")(function* () {
      return "10000000-0000-4000-8000-000000000001";
    }),
    record: Effect.fn("ManagedProvisioningIntents.record")(function* () {}),
  }),
  Layer.succeed(DeliveryAuthorization, {
    eligible: Effect.fn("DeliveryAuthorization.eligible")(function* () {
      return true;
    }),
    result: Effect.fn("DeliveryAuthorization.result")(function* <E, R>(
      effect: Effect.Effect<void, E, R>,
    ) {
      return yield* effect;
    }),
  }),
  Layer.succeed(HookDeliveryAuthorization, {
    allowed: Effect.fn("HookDeliveryAuthorization.allowed")(function* () {
      return true;
    }),
  }),
  Layer.succeed(ManagedTunnelLimits, {
    ensureCapacity: Effect.fn("ManagedTunnelLimits.ensureCapacity")(function* () {}),
  }),
);

export const identityUnitLayer = (config: RelayConfiguration["Service"]) =>
  Layer.succeed(EndpointIdentity, {
    resolve: Effect.fn("EndpointIdentity.resolve")(function* (input) {
      const stage = config.managedEndpointNamespace ?? "prod";
      const hash = NodeCrypto.createHash("sha256")
        .update(managedEndpointDigestInput(stage, input.userId, input.environmentId))
        .digest("hex");
      return {
        endpointGeneration: 0,
        endpointKey: hash.slice(0, 16),
        hostname: managedEndpointHostname(
          stage,
          config.managedEndpointBaseDomain ?? "example.test",
          hash,
        ),
        tunnelName: managedEndpointTunnelName(stage, hash),
      };
    }),
    check: Effect.fn("EndpointIdentity.check")(function* () {}),
  });
