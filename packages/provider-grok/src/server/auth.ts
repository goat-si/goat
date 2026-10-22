/**
 * In-app xAI API key sign-in for one Grok provider instance.
 *
 * The key is stored in the server secret store and copied into the Grok CLI
 * environment as `XAI_API_KEY` when that variable is not already set. Sign-out
 * deletes the stored key. The value is never written to logs, auth state, or
 * MCP results (`redactProviderAuthState` drops credential fields).
 */
import { ProviderSetupError, type ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderAuthController } from "@goat/provider-core/server/auth";
import type { ProviderCredentials } from "@goat/provider-core/server/ProviderHost";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as ProviderAuthFlow from "@goat/provider-core/server/providerAuthFlow";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

/** Variable the Grok CLI reads. Instance and process env win over the stored key. */
export const GROK_API_KEY_ENV = "XAI_API_KEY";
export const GROK_CREDENTIAL_NAMESPACE = "grok";

const API_KEY_METHOD_ID = "api-key";
const API_KEY_FIELD = "apiKey";

const failure = (
  instanceId: ProviderInstanceId,
  operation: string,
  detail: string,
  cause?: unknown,
) =>
  new ProviderSetupError({
    instanceId,
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

function decodeStoredApiKey(bytes: Uint8Array): string | undefined {
  const value = new TextDecoder().decode(bytes).trim();
  return value.length > 0 ? value : undefined;
}

export const readStoredGrokApiKey = (
  credentials: ProviderCredentials,
): Effect.Effect<string | undefined> =>
  credentials.get.pipe(
    Effect.map((stored) => (Option.isNone(stored) ? undefined : decodeStoredApiKey(stored.value))),
    Effect.tapError((error) =>
      Effect.logWarning("Could not read the stored Grok API key.", {
        operation: error.operation,
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );

/** Fills `XAI_API_KEY` from the secret store only when the launch env has none. */
export function applyStoredGrokApiKey(
  environment: NodeJS.ProcessEnv,
  storedKey: string | undefined,
): NodeJS.ProcessEnv {
  if (environment[GROK_API_KEY_ENV]?.trim() || !storedKey) return environment;
  return { ...environment, [GROK_API_KEY_ENV]: storedKey };
}

export const resolveGrokLaunchEnvironment = Effect.fnUntraced(function* (
  instanceId: ProviderInstanceId,
  environment: NodeJS.ProcessEnv,
) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
    GROK_CREDENTIAL_NAMESPACE,
    instanceId,
  );
  return applyStoredGrokApiKey(environment, yield* readStoredGrokApiKey(credentials));
});

export function withGrokAuthPresentation(
  snapshot: ServerProvider,
  input: {
    readonly enabled: boolean;
    readonly hasEnvironmentKey: boolean;
    readonly hasStoredKey: boolean;
  },
): ServerProvider {
  return {
    ...snapshot,
    setup: {
      canAuthenticate: input.enabled && !input.hasEnvironmentKey,
      canInstall: false,
    },
    auth: {
      ...snapshot.auth,
      canLogout: input.hasStoredKey,
    },
  };
}

export interface GrokAuth {
  readonly controller: ProviderAuthController;
  readonly readStored: Effect.Effect<string | undefined>;
}

export const makeGrokAuth = Effect.fnUntraced(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly hasEnvironmentKey: boolean;
  readonly onChanged: (expectAuthenticated: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
    GROK_CREDENTIAL_NAMESPACE,
    options.instanceId,
  );
  const readStored = readStoredGrokApiKey(credentials);
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: credentials.binding,
    methods: Effect.succeed([
      {
        id: API_KEY_METHOD_ID,
        name: "xAI API key",
        description: "Paste an API key from the xAI console. It stays on this server.",
        type: "credentials" as const,
      },
    ]),
    defaultMethodId: API_KEY_METHOD_ID,
    authenticate: (_, context) =>
      Effect.gen(function* () {
        if (!options.enabled) {
          return yield* failure(options.instanceId, "start", "Enable Grok before signing in.");
        }
        if (options.hasEnvironmentKey) {
          return yield* failure(
            options.instanceId,
            "start",
            "Remove XAI_API_KEY from this provider's environment before saving a key here.",
          );
        }
        const submitted = yield* Deferred.make<string, ProviderSetupError>();
        yield* context.setInteraction(
          {
            type: "credentials",
            id: API_KEY_METHOD_ID,
            fields: [{ name: API_KEY_FIELD, label: "API key", secret: true }],
          },
          (response) => {
            if (response.type !== "credentials") {
              return Effect.fail(
                failure(options.instanceId, "respond", "Enter an API key to continue."),
              );
            }
            const key = response.values[API_KEY_FIELD]?.trim() ?? "";
            if (!key) {
              return Effect.fail(
                failure(options.instanceId, "respond", "Enter an API key to continue."),
              );
            }
            return Deferred.succeed(submitted, key).pipe(
              Effect.mapError(() =>
                failure(options.instanceId, "respond", "This sign-in is no longer active."),
              ),
            );
          },
        );
        const key = yield* Deferred.await(submitted);
        // The response handler is still unwinding. Finishing sign-in before it
        // returns interrupts that handler and the client sees a failed submit.
        yield* Effect.yieldNow;
        yield* context.verifying;
        yield* credentials
          .set(new TextEncoder().encode(key))
          .pipe(
            Effect.mapError((cause) =>
              failure(
                options.instanceId,
                "start",
                "Could not save the Grok API key. Try again.",
                cause,
              ),
            ),
          );
        const verified = yield* options.onChanged(true).pipe(Effect.exit);
        if (Exit.isFailure(verified)) {
          yield* credentials.remove.pipe(Effect.ignore);
          return yield* Effect.failCause(verified.cause);
        }
      }),
    logout: Effect.gen(function* () {
      const stored = yield* readStored;
      if (!stored && options.hasEnvironmentKey) {
        return yield* failure(
          options.instanceId,
          "logout",
          "Remove XAI_API_KEY from this provider's environment to disconnect it.",
        );
      }
      if (stored) {
        yield* credentials.remove.pipe(
          Effect.mapError((cause) =>
            failure(
              options.instanceId,
              "logout",
              "Could not remove the stored Grok API key. Try again.",
              cause,
            ),
          ),
        );
      }
      yield* options.onChanged(false);
      return options.hasEnvironmentKey
        ? "Removed the saved API key. XAI_API_KEY in this provider's environment still signs Grok in."
        : undefined;
    }),
  });
  return { controller, readStored };
});
