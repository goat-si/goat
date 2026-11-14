import type { ProviderInstanceEnvironment } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

/** A plain environment, or one merged again from the host environment each time it runs. */
export type Source = NodeJS.ProcessEnv | Effect.Effect<NodeJS.ProcessEnv>;

/** Merges the instance's variables over the host environment as it is when the effect runs. */
export const makeCurrent = Effect.fn("CursorSessionEnvironment.makeCurrent")(function* (
  environment: ProviderInstanceEnvironment | undefined,
) {
  const host = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  return Effect.suspend(() => mergeProviderInstanceEnvironment(environment, host)).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
  );
});

/** The environment and API key a new session starts with; a running session keeps its own. */
export const forSession = (source: Source) =>
  (Effect.isEffect(source) ? source : Effect.succeed(source)).pipe(
    Effect.map((environment) => ({
      environment: { ...environment },
      apiKey: environment.CURSOR_API_KEY?.trim() || undefined,
    })),
  );
