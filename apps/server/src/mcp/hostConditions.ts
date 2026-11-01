/**
 * What this host knows now that availability needs beyond a caller's scope and profile.
 *
 * @module hostConditions
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ComputerUseAgentConnections from "../cua/ComputerUseAgentConnections.ts";
import type { HostConditions } from "./toolAvailability.ts";

/** Reads this host's conditions each time; a server without computer use has none. */
export const makeHostConditions = Effect.gen(function* () {
  const connections = yield* Effect.serviceOption(
    ComputerUseAgentConnections.ComputerUseAgentConnections,
  );
  return Option.isNone(connections)
    ? Effect.succeed<HostConditions>({})
    : connections.value.failure.pipe(
        Effect.map((failure): HostConditions =>
          failure === undefined ? {} : { computerUseFailure: failure.message },
        ),
      );
});
