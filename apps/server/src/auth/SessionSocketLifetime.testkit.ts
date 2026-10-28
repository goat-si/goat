import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import * as SessionStore from "./SessionStore.ts";

/** Sessions whose authority never changes, for routes that guard their sockets. */
export const layerStable = Layer.mergeAll(
  Layer.unwrap(
    SubscriptionRef.make({ generation: 0, allowed: false, fenced: false }).pipe(
      Effect.map((state) =>
        Layer.mock(HubConnectAccess.HubConnectAccess, {
          state,
          current: SubscriptionRef.get(state),
          awaitDenial: () => Effect.never,
        }),
      ),
    ),
  ),
  Layer.mock(SessionStore.SessionStore, {
    cookieName: "test-session",
    legacyCookieName: undefined,
    awaitInvalidation: () => Effect.never,
  }),
);

/** Sessions that stay valid until `revoked` settles. */
export const layerRevocable = (revoked: Promise<void>) =>
  Layer.mergeAll(
    Layer.unwrap(
      SubscriptionRef.make({ generation: 0, allowed: false, fenced: false }).pipe(
        Effect.map((state) =>
          Layer.mock(HubConnectAccess.HubConnectAccess, {
            state,
            current: SubscriptionRef.get(state),
            awaitDenial: () => Effect.never,
          }),
        ),
      ),
    ),
    Layer.mock(SessionStore.SessionStore, {
      cookieName: "test-session",
      legacyCookieName: undefined,
      awaitInvalidation: () => Effect.promise(() => revoked),
    }),
  );
