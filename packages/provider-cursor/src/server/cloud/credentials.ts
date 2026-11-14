import type { StoredSdkCredentials } from "@cursor/sdk";
import { ProviderSetupError, type ProviderInstanceId } from "@goat/contracts";
import type { ProviderAuthController } from "@goat/provider-core/server/auth";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export { sdkBackendMatches } from "../sdkBackend.ts";
export { cloudSdkBackendMatches } from "../sdkBackend.ts";
const PRODUCTION_BACKEND = "https://api2.cursor.sh";
export const BACKEND_MISMATCH =
  "Cursor Cloud supports production backends only: unset CURSOR_BACKEND_URL on the server and in the selected Cursor provider (or set the provider value to https://api2.cursor.sh), then restart the server.";
const Credentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    backendUrl: Schema.String,
    apiKey: Schema.String,
    createdAtMs: Schema.Finite,
    apiKeyExpiresAtMs: Schema.optionalKey(Schema.Finite),
    email: Schema.optionalKey(Schema.String),
  }),
);

const decodeCredentials = Schema.decodeEffect(Credentials);

function usable(value: StoredSdkCredentials | undefined, now: number) {
  return (
    value !== undefined &&
    value.apiKey.trim().length > 0 &&
    value.backendUrl.replace(/\/+$/, "") === PRODUCTION_BACKEND &&
    (value.apiKeyExpiresAtMs === undefined || value.apiKeyExpiresAtMs > now)
  );
}

/**
 * Cursor Cloud uses exactly the account of its selected Cursor provider: that provider's
 * CURSOR_API_KEY (instance settings over the server environment, as the local provider
 * resolves it), else its GOAT sign-in. Other logins on the machine are never consulted.
 */
export const resolveKey = Effect.fn("CursorCloud.resolveKey")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly configuredKey?: string;
  readonly sibling: Effect.Effect<StoredSdkCredentials | undefined, ProviderSetupError>;
}) {
  const configuredKey = input.configuredKey?.trim();
  if (configuredKey) return configuredKey;
  const now = yield* Clock.currentTimeMillis;
  const sibling = yield* input.sibling;
  if (usable(sibling, now)) return sibling!.apiKey;
  return yield* new ProviderSetupError({
    instanceId: input.instanceId,
    operation: "credentials",
    detail: "Sign in with the selected Cursor provider, or add CURSOR_API_KEY to its settings.",
  });
});

export const makeCursorCloudCredentials = Effect.fn("makeCursorCloudCredentials")(function* (
  instanceId: ProviderInstanceId,
  siblingId: ProviderInstanceId,
) {
  const host = yield* ProviderHost.ProviderHost;
  const hostEnvironment = yield* HostProcess.Environment;
  const credentials = yield* host.credentials("cursor", siblingId);
  const failure = (cause: unknown) =>
    new ProviderSetupError({
      instanceId,
      operation: "credentials",
      detail: "Could not read the selected Cursor sign-in.",
      cause,
    });
  const requireApiKey = Effect.gen(function* () {
    const settings = yield* host.settings.get.pipe(Effect.mapError(failure));
    const sibling = settings.providerInstances[siblingId];
    if (
      (sibling === undefined && siblingId !== "cursor") ||
      (sibling !== undefined && sibling.driver !== "cursor")
    ) {
      return yield* new ProviderSetupError({
        instanceId,
        operation: "credentials",
        detail: "The selected credential source must be an existing Cursor provider instance.",
      });
    }
    const environment = yield* mergeProviderInstanceEnvironment(
      sibling?.environment,
      hostEnvironment,
    );
    if (
      environment.CURSOR_BACKEND_URL !== undefined &&
      environment.CURSOR_BACKEND_URL.replace(/\/+$/, "") !== PRODUCTION_BACKEND
    ) {
      return yield* new ProviderSetupError({
        instanceId,
        operation: "credentials",
        detail: BACKEND_MISMATCH,
      });
    }
    const configuredKey = environment.CURSOR_API_KEY;
    const stored = credentials.get.pipe(
      Effect.mapError(failure),
      Effect.flatMap((bytes) =>
        Option.isNone(bytes)
          ? Effect.succeed(undefined)
          : decodeCredentials(new TextDecoder().decode(bytes.value)).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
      ),
    );
    return yield* resolveKey({
      instanceId,
      ...(configuredKey ? { configuredKey } : {}),
      sibling: stored,
    });
  });
  const useSibling = () =>
    Effect.fail(
      new ProviderSetupError({
        instanceId,
        operation: "credentials",
        detail: "Manage this account in the selected Cursor provider's settings.",
      }),
    );
  const auth: ProviderAuthController = {
    credentialBinding: credentials.binding,
    start: useSibling,
    complete: useSibling,
    cancel: useSibling,
    logout: useSibling,
    subscribe: () => Stream.empty,
  };
  return { requireApiKey, auth };
});
