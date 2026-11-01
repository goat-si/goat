import { WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../../connection/supervisor.ts";

/** The notes wire group is available before the general subscription tag catalog is extended. */
export const noteSubscriptionSessions = Stream.unwrap(
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    return SubscriptionRef.changes(supervisor.session).pipe(
      Stream.map(
        Option.map((session) => ({
          subscribe: () => session.client[WS_METHODS.notesSubscribe]({}),
        })),
      ),
    );
  }),
);
