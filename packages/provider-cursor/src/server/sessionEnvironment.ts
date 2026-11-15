import { sdkBackendMatches } from "./cloud/credentials.ts";
import type {
  ProviderInstanceEnvironment,
  ProviderSetupError,
  ServerProviderModel,
} from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import { CursorAgentSdkRunnerError } from "./CursorAgentSdk.ts";

/** A plain environment, or one merged again from the host environment each time it runs. */
export type Source = NodeJS.ProcessEnv | Effect.Effect<NodeJS.ProcessEnv>;

/** The model catalog a key was last checked with at the backend `environment` names, if any. */
export type CatalogModels = (
  apiKey: string | undefined,
  environment: NodeJS.ProcessEnv,
) => ReadonlyArray<ServerProviderModel>;

export interface SessionAuth {
  readonly resolveSessionApiKey?: (
    key: string | undefined,
    backendUrl: string | undefined,
  ) => Effect.Effect<string, ProviderSetupError>;
  readonly validateSessionApiKey?: (
    key: string | undefined,
    environmentKey: string | undefined,
    backendUrl: string | undefined,
  ) => Effect.Effect<void, ProviderSetupError>;
  readonly agentTransportRefusal?:
    | ((environment: NodeJS.ProcessEnv) => Effect.Effect<string | undefined>)
    | undefined;
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
        auth.resolveSessionApiKey?.(environmentKey, copy.CURSOR_BACKEND_URL) ??
        Effect.succeed(environmentKey);
      // Decided once: the SDK's transport cannot change, so a running session never re-reads it.
      const transport = auth.agentTransportRefusal?.(copy) ?? Effect.undefined;
      return Effect.all([key, transport]).pipe(
        Effect.map(([apiKey, transportRefusal]) => ({
          environment: copy,
          apiKey,
          validate: (
            auth.validateSessionApiKey?.(apiKey, environmentKey, copy.CURSOR_BACKEND_URL) ??
            Effect.void
          ).pipe(
            Effect.mapError((cause) => new CursorAgentSdkRunnerError({ method: "open", cause })),
            Effect.andThen(
              Effect.suspend(() =>
                sdkBackendMatches(copy.CURSOR_BACKEND_URL)
                  ? Effect.void
                  : Effect.fail(
                      new CursorAgentSdkRunnerError({
                        method: "open",
                        cause: new Error(
                          "Cursor backend differs from the loaded SDK or current environment. Restart GOAT to use a different Cursor backend.",
                        ),
                      }),
                    ),
              ),
            ),
            Effect.andThen(
              transportRefusal === undefined
                ? Effect.void
                : Effect.fail(
                    new CursorAgentSdkRunnerError({
                      method: "open",
                      cause: new Error(transportRefusal),
                    }),
                  ),
            ),
          ),
        })),
      );
    }),
  );
