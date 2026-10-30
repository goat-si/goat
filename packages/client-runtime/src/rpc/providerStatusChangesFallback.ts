import type {
  ServerConfigStreamEvent,
  ServerProvider,
  WsSubscribeServerConfigRpc,
} from "@goat/contracts";
import {
  applyProviderStatusChanges,
  canApplyProviderStatusChanges,
} from "@goat/shared/providerStatusChanges";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";

type ServerConfigSubscriptionPayload = Rpc.Payload<typeof WsSubscribeServerConfigRpc>;

/**
 * Subscribes with providerStatusChanges. A change this client cannot apply ends that
 * subscription and opens it once more without the flag, so the server sends full provider lists
 * for the rest of the session; the new subscription starts with a snapshot.
 */
export const withProviderStatusChangesOrFullLists = <E, R>(
  open: (input: ServerConfigSubscriptionPayload) => Stream.Stream<ServerConfigStreamEvent, E, R>,
  input: ServerConfigSubscriptionPayload,
): Stream.Stream<ServerConfigStreamEvent, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // This subscription's own provider list, updated with each event as it is judged.
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider> | undefined>(undefined);
      const switched = yield* Ref.make(false);
      const judge = Effect.fn("RpcSession.judgeProviderStatusChanges")(function* (
        event: ServerConfigStreamEvent,
      ) {
        const current = yield* Ref.get(providers);
        switch (event.type) {
          case "snapshot":
            yield* Ref.set(providers, event.config.providers);
            return { event, usable: true };
          case "providerStatuses":
            yield* Ref.set(providers, event.payload.providers);
            return { event, usable: true };
          case "providerStatusChanges": {
            if (current === undefined || !canApplyProviderStatusChanges(current, event.payload)) {
              yield* Ref.set(switched, true);
              return { event, usable: false };
            }
            yield* Ref.set(providers, applyProviderStatusChanges(current, event.payload));
            return { event, usable: true };
          }
          default:
            return { event, usable: true };
        }
      });
      const changes = open({ ...input, providerStatusChanges: true }).pipe(
        Stream.mapEffect(judge),
        Stream.takeUntil((judged) => !judged.usable, { excludeLast: true }),
        Stream.map((judged) => judged.event),
      );
      const fullLists = Stream.unwrap(
        Ref.get(switched).pipe(Effect.map((done) => (done ? open(input) : Stream.empty))),
      );
      return Stream.concat(changes, fullLists);
    }),
  );
