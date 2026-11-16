import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { replacedSincePress } from "../connection/sessionPublication.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";

export { latestSessionPublication } from "../connection/sessionPublication.ts";

/** The session publication current when the command was pressed. Outside a command, none is. */
class CommandPressedAt extends Context.Reference<number>(
  "@goat/client-runtime/state/CommandPressedAt",
  { defaultValue: () => Number.POSITIVE_INFINITY },
) {}

export const pressedAt =
  (publication: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CommandPressedAt, publication);

/**
 * Refuses a command whose computer reconnected after it was pressed: it waited behind another
 * command, and the person pressed it for the session that went away. With no session it runs on,
 * and its request fails as not connected.
 */
export const requireIssuingSession = Effect.fn("EnvironmentCommand.requireIssuingSession")(
  function* () {
    const pressed = yield* CommandPressedAt;
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const current = yield* SubscriptionRef.get(supervisor.session);
    const { target } = supervisor;
    if (
      Option.isSome(current) &&
      replacedSincePress(target.environmentId, current.value, pressed)
    ) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: target.environmentId,
        message: `${target.label} reconnected before this ran, so it was not sent. Try again.`,
      });
    }
  },
);

/** Builds the command's effect only after the check, since some commands act while building it. */
export const inIssuingSession = <A, E, R>(execute: () => Effect.Effect<A, E, R>) =>
  requireIssuingSession().pipe(Effect.andThen(Effect.suspend(execute)));
