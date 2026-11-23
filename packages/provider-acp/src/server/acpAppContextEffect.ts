import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { ActiveAcpTurn } from "./activeTurn.ts";
import type { createAcpAppContext } from "./acpAppContext.ts";

type Delivery = ReturnType<typeof createAcpAppContext>;
export const prepareAcpAppContext = Effect.fn("AcpAppContext.prepare")(
  (
    delivery: Delivery,
    sessionId: string,
    userText: string,
    appContext: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"],
    driver: ProviderDriverKind,
  ) =>
    Effect.try({
      try: () =>
        delivery.prepare({
          sessionId,
          userText,
          ...(appContext === undefined ? {} : { appContext }),
        }),
      catch: (cause) =>
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "Invalid or oversized ACP app context",
          cause,
        }),
    }),
);

/** App context for a steer prompt, keyed by the session the active turn runs in. */
export const steerAcpAppContext =
  (delivery: Delivery, driver: ProviderDriverKind) =>
  (sessionId: string, input: ProviderAdapter.ProviderAdapterV2SteerInput) =>
    prepareAcpAppContext(delivery, sessionId, input.message.text, input.appContext, driver);

// Runs for each ACP update under the adapter's existing tracing boundary.
export const observeLateAcpCompaction = Effect.fnUntraced(function* (
  delivery: Delivery,
  markers: Ref.Ref<Map<string, symbol>>,
  activeSessionId: Ref.Ref<string | null>,
  notification: EffectAcpSchema.SessionNotification,
  context: ActiveAcpTurn | null,
) {
  const update = notification.update;
  if (
    (context === null || context.finalized) &&
    update.sessionUpdate === "compaction_update" &&
    update.status === "completed" &&
    notification.sessionId === (yield* Ref.get(activeSessionId))
  ) {
    delivery.invalidate(notification.sessionId);
    yield* Ref.update(markers, (current) => new Map(current).set(notification.sessionId, Symbol()));
  }
});
