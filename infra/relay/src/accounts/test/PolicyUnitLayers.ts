// @effect-diagnostics nodeBuiltinImport:off -- Pure crypto and provider unit fixtures use deterministic synthetic account policy.
import { createHash } from "node:crypto";
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
    admit: (userId) => Effect.succeed({ userId, accountEpoch: 1 }),
    capture: (userId) => Effect.succeed({ userId, accountEpoch: 1 }),
    requireAllowed: (input) => Effect.succeed({ userId: input.userId, accountEpoch: 1 }),
  }),
  Layer.succeed(AccountTransactions, { run: (_input, effect) => effect }),
  Layer.succeed(RelayRateLimits, { charge: () => Effect.void }),
  Layer.succeed(AccountLimits, DEFAULT_LIMITS),
  Layer.succeed(EnvironmentOwnership, {
    beginRelease: () => Effect.succeed([]),
    finishRelease: () => Effect.succeed(true),
    claim: () => Effect.void,
    assertActive: () => Effect.void,
  }),
  Layer.succeed(AccountDeviceAdmission, {
    write: (_input, body) => body(1),
    unregister: (_userId, body) => body,
  }),
  Layer.succeed(ManagedProvisioningIntents, {
    prepare: () => Effect.succeed("10000000-0000-4000-8000-000000000001"),
    record: () => Effect.void,
  }),
  Layer.succeed(DeliveryAuthorization, {
    eligible: () => Effect.succeed(true),
    result: (effect) => effect,
  }),
  Layer.succeed(HookDeliveryAuthorization, {
    allowed: () => Effect.succeed(true),
  }),
  Layer.succeed(ManagedTunnelLimits, { ensureCapacity: () => Effect.void }),
);

export const identityUnitLayer = (config: RelayConfiguration["Service"]) =>
  Layer.succeed(EndpointIdentity, {
    resolve: (input) =>
      Effect.sync(() => {
        const stage = config.managedEndpointNamespace ?? "prod";
        const hash = createHash("sha256")
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
    check: () => Effect.void,
  });
