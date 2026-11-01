import { AccountLimits } from "../accounts/AccountLimits.ts";
import { and, count, eq, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    readonly ensureCapacity: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError>;
  }
>()("goat-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const limits = yield* AccountLimits;

  return ManagedTunnelLimits.of({
    ensureCapacity: Effect.fn("relay.managed_tunnel_limits.ensure_capacity")(function* (input) {
      const current = yield* db
        .select({ id: relayManagedEndpointAllocations.incarnationId })
        .from(relayManagedEndpointAllocations)
        .where(
          and(
            eq(relayManagedEndpointAllocations.userId, input.userId),
            eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
            isNull(relayManagedEndpointAllocations.capacityReleasedAt),
            isNull(relayManagedEndpointAllocations.deletedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedTunnelLimitPersistenceError({
                operation: "count-tunnels",
                userId: input.userId,
                cause,
              }),
          ),
        );
      if (current.length > 0) return;
      const overrides = yield* db
        .select({ maxTunnels: relayManagedTunnelLimits.maxTunnels })
        .from(relayManagedTunnelLimits)
        .where(eq(relayManagedTunnelLimits.userId, input.userId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedTunnelLimitPersistenceError({
                operation: "load-limit",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const maxTunnels = overrides[0]?.maxTunnels ?? limits.tunnels;

      const counted = yield* db
        .select({ activeTunnels: count() })
        .from(relayManagedEndpointAllocations)
        .where(
          and(
            eq(relayManagedEndpointAllocations.userId, input.userId),
            isNull(relayManagedEndpointAllocations.capacityReleasedAt),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedTunnelLimitPersistenceError({
                operation: "count-tunnels",
                userId: input.userId,
                cause,
              }),
          ),
        );
      const activeTunnels = counted[0]?.activeTunnels ?? 0;

      if (activeTunnels >= maxTunnels) {
        return yield* new ManagedTunnelLimitExceeded({
          userId: input.userId,
          environmentId: input.environmentId,
          maxTunnels,
          activeTunnels,
        });
      }
    }),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
