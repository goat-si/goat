import type { EnvironmentId as EnvironmentIdType } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type * as EnvironmentSupervisor from "../connection/supervisor.ts";

function runInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | EnvironmentRegistry.EnvironmentNotRegisteredError,
  EnvironmentRegistry.EnvironmentRegistry | Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
> {
  return EnvironmentRegistry.EnvironmentRegistry.pipe(
    Effect.flatMap((registry) => registry.run(environmentId, effect)),
  );
}

export { runInEnvironment };
