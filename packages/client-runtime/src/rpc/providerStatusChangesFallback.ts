import type {
  ServerConfigStreamEvent,
  ServerProvider,
  WsSubscribeServerConfigRpc,
} from "@goat/contracts";
import {
  applyProviderStatusChanges,
  canApplyProviderStatusChanges,
} from "@goat/shared/providerStatusChanges";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClientError from "effect/rpc/RpcClientError";

import { SYNCHRONIZATION_TIMEOUT } from "../connection/synchronization.ts";

type ServerConfigSubscriptionPayload = Rpc.Payload<typeof WsSubscribeServerConfigRpc>;

/** Fails a subscription whose first event does not arrive in time, so the session reconnects. */
const answeredInTime = <E, R>(stream: Stream.Stream<ServerConfigStreamEvent, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const answered = yield* Deferred.make<void>();
      const deadline = Stream.fromEffect(
        Deferred.await(answered).pipe(
          Effect.timeoutOrElse({
            duration: SYNCHRONIZATION_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: `The config subscription did not answer within ${Duration.toSeconds(SYNCHRONIZATION_TIMEOUT)}s after switching to full provider lists.`,
                    cause: undefined,
                  }),
                }),
              ),
          }),
        ),
      ).pipe(Stream.drain);
      // Ends with the subscription, so one that closes before answering is not reported as silent.
      return stream.pipe(
        Stream.tap(() => Deferred.succeed(answered, undefined)),
        Stream.merge(deadline, { haltStrategy: "left" }),
      );
    }),
  );

/**
 * Subscribes with providerStatusChanges. A change this client cannot apply ends that
 * subscription and opens it once more without the flag, so the server sends full provider lists
 * for the rest of the session; the new subscription starts with a snapshot. An explicit false
 * keeps full lists from the start.
 */
export const withProviderStatusChangesOrFullLists = <E, R>(
  open: (input: ServerConfigSubscriptionPayload) => Stream.Stream<ServerConfigStreamEvent, E, R>,
  input: ServerConfigSubscriptionPayload,
): Stream.Stream<ServerConfigStreamEvent, E | RpcClientError.RpcClientError, R> => {
  const { providerStatusChanges, ...fullListInput } = input;
  if (providerStatusChanges === false) return open(input);
  return Stream.unwrap(
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
      const changes = open({ ...fullListInput, providerStatusChanges: true }).pipe(
        Stream.mapEffect(judge),
        Stream.takeUntil((judged) => !judged.usable, { excludeLast: true }),
        Stream.map((judged) => judged.event),
      );
      const fullLists = Stream.unwrap(
        Ref.get(switched).pipe(
          Effect.map((done) => (done ? answeredInTime(open(fullListInput)) : Stream.empty)),
        ),
      );
      return Stream.concat(changes, fullLists);
    }),
  );
};
