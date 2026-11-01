import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { handleConnectionCatalogOperation } from "./catalogHost.ts";
import { PrimaryConnectionTarget, RelayConnectionTarget } from "./model.ts";
import * as Onboarding from "./onboarding.ts";
import * as Registry from "./registry.ts";

const environmentId = EnvironmentId.make("legacy-relay");
const relay: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId, label: "Legacy relay" }),
  profile: Option.none(),
  enabled: true,
};
const primary: ConnectionCatalogEntry = {
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "Local",
    httpBaseUrl: "http://localhost/",
    wsBaseUrl: "ws://localhost/",
  }),
  profile: Option.none(),
  enabled: true,
};

describe("connection catalog host with Connect disabled", () => {
  it.effect.each([relay, primary])(
    "allows local forget of disabled relay entries while retaining platform protection (%s)",
    (saved) =>
      Effect.gen(function* () {
        const entries = yield* SubscriptionRef.make<
          ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
        >(new Map([[environmentId, saved]]));
        const networkStatus = yield* SubscriptionRef.make<"online" | "offline" | "unknown">(
          "online",
        );
        const removed: EnvironmentId[] = [];
        const unused = () => Effect.die("Unexpected catalog or network work");
        const registry = Registry.EnvironmentRegistry.of({
          entries,
          networkStatus,
          start: Effect.void,
          register: unused,
          assertKnownAddress: unused,
          registerPlatform: unused,
          reconcilePlatform: unused,
          remove: (id) =>
            SubscriptionRef.update(entries, (current) => {
              removed.push(id);
              const next = new Map(current);
              next.delete(id);
              return next;
            }),
          removeRoute: unused,
          reorderRoutes: unused,
          removeRelayEnvironments: unused,
          retryNow: unused,
          setEnabled: unused,
          setCompatibility: unused,
          state: unused,
          stateChanges: () => Stream.die("unused"),
          run: unused,
          runStream: () => Stream.die("unused"),
          followStream: () => Stream.die("unused"),
        });
        const operation = (type: "list" | "remove") =>
          handleConnectionCatalogOperation(
            type === "list" ? { type } : { type, environmentId },
            unused,
          ).pipe(
            Effect.provideService(Registry.EnvironmentRegistry, registry),
            Effect.provideService(Onboarding.ConnectionOnboarding, {
              registerPairing: unused,
              updateBearer: unused,
              registerSsh: unused,
            }),
          );
        yield* operation("list");
        expect((yield* SubscriptionRef.get(entries)).get(environmentId)).toBe(saved);
        const result = yield* operation("remove");
        if (saved === relay) {
          expect(result).toMatchObject({
            type: "remove",
            removed: { environmentId, routes: [{ kind: "t3-connect" }] },
          });
          expect(removed).toEqual([environmentId]);
          expect((yield* SubscriptionRef.get(entries)).size).toBe(0);
        } else {
          expect(result).toMatchObject({ type: "failure", reason: "refused" });
          expect(removed).toEqual([]);
          expect((yield* SubscriptionRef.get(entries)).get(environmentId)).toBe(saved);
        }
      }),
  );
});
