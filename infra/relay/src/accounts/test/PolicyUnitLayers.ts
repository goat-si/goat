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
    admit: Effect.fnUntraced((userId) => Effect.succeed({ userId, accountEpoch: 1 })),
    capture: Effect.fnUntraced((userId) => Effect.succeed({ userId, accountEpoch: 1 })),
    requireAllowed: Effect.fnUntraced((input) =>
      Effect.succeed({ userId: input.userId, accountEpoch: 1 }),
    ),
  }),
  Layer.succeed(AccountTransactions, { run: Effect.fnUntraced((_input, effect) => effect) }),
  Layer.succeed(RelayRateLimits, { charge: Effect.fnUntraced(() => Effect.void) }),
  Layer.succeed(AccountLimits, DEFAULT_LIMITS),
  Layer.succeed(EnvironmentOwnership, {
    beginRelease: Effect.fnUntraced(() => Effect.succeed([])),
    finishRelease: Effect.fnUntraced(() => Effect.succeed(true)),
    claim: Effect.fnUntraced(() => Effect.void),
    assertActive: Effect.fnUntraced(() => Effect.void),
  }),
  Layer.succeed(AccountDeviceAdmission, {
    write: Effect.fnUntraced((_input, body) => body(1)),
    unregister: Effect.fnUntraced((_userId, body) => body),
  }),
  Layer.succeed(ManagedProvisioningIntents, {
    prepare: Effect.fnUntraced(() => Effect.succeed("10000000-0000-4000-8000-000000000001")),
    record: Effect.fnUntraced(() => Effect.void),
  }),
  Layer.succeed(DeliveryAuthorization, {
    eligible: Effect.fnUntraced(() => Effect.succeed(true)),
    result: Effect.fnUntraced((effect) => effect),
  }),
  Layer.succeed(HookDeliveryAuthorization, {
    allowed: Effect.fnUntraced(() => Effect.succeed(true)),
  }),
  Layer.succeed(ManagedTunnelLimits, { ensureCapacity: Effect.fnUntraced(() => Effect.void) }),
);

export const identityUnitLayer = (config: RelayConfiguration["Service"]) =>
  Layer.succeed(EndpointIdentity, {
    resolve: Effect.fnUntraced((input) =>
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
    ),
    check: Effect.fnUntraced(() => Effect.void),
  });
