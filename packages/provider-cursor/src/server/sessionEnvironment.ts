import { sdkBackendMatches } from "./cloud/credentials.ts";
import type { ProviderInstanceEnvironment, ProviderSetupError } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import { CursorAgentSdkRunnerError } from "./CursorAgentSdk.ts";

/** A plain environment, or one merged again from the host environment each time it runs. */
export type Source = NodeJS.ProcessEnv | Effect.Effect<NodeJS.ProcessEnv>;

export interface SessionAuth {
  readonly resolveSessionApiKey?: (
    key: string | undefined,
  ) => Effect.Effect<string, ProviderSetupError>;
  readonly validateSessionApiKey?: (
    key: string | undefined,
    environmentKey: string | undefined,
  ) => Effect.Effect<void, ProviderSetupError>;
}

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
export const forSession = (source: Source, auth: SessionAuth = {}) =>
  (Effect.isEffect(source) ? source : Effect.succeed(source)).pipe(
    Effect.flatMap((environment) => {
      const copy = { ...environment };
      const environmentKey = copy.CURSOR_API_KEY?.trim() || undefined;
      const key: Effect.Effect<string | undefined, ProviderSetupError> =
        auth.resolveSessionApiKey?.(environmentKey) ?? Effect.succeed(environmentKey);
      return key.pipe(
        Effect.map((apiKey) => ({
          environment: copy,
          apiKey,
          validate: (auth.validateSessionApiKey?.(apiKey, environmentKey) ?? Effect.void).pipe(
            Effect.mapError((cause) => new CursorAgentSdkRunnerError({ method: "open", cause })),
            Effect.andThen(
              Effect.suspend(() =>
                sdkBackendMatches(copy.CURSOR_BACKEND_URL)
                  ? Effect.void
                  : Effect.fail(
                      new CursorAgentSdkRunnerError({
                        method: "open",
                        cause: new Error("CURSOR_BACKEND_URL differs from the session backend."),
                      }),
                    ),
              ),
            ),
          ),
        })),
      );
    }),
  );
