import {
  DeviceEasAccountError,
  type DeviceEasAccountInput,
  type SecretReference,
  type ServerSettings,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { cachedResolveSecret } from "../secrets/secretResolver.ts";
import type * as Settings from "../serverSettings.ts";
import { makeExpoApi, resolveExpoCredential } from "./ExpoApi.ts";

export class EasSecretCredentialError extends Schema.TaggedError<EasSecretCredentialError>()(
  "EasSecretCredentialError",
  {},
) {
  override get message() {
    return "Could not read the Expo token from its secret provider.";
  }
}

export const readEasToken = Effect.fn("EasDeviceHost.readSecretToken")(function* (
  settings: ServerSettings,
  token: string,
  reference: SecretReference | null | undefined,
  resolve: (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ) => Promise<string> = cachedResolveSecret,
) {
  if (reference == null) return token;
  const value = yield* Effect.tryPromise({
    try: () => resolve(settings.secretProviders, reference),
    catch: () => new EasSecretCredentialError(),
  });
  if (!value.trim()) return yield* new EasSecretCredentialError();
  return value;
});

export const checkEasAccount = Effect.fn("DeviceService.easAccount")(
  function* (settings: Settings.ServerSettingsService["Service"], input: DeviceEasAccountInput) {
    const current = yield* settings.getSettings;
    const host = current.easDeviceHosts.find((host) => host.id === input.hostId);
    const saved = yield* readEasToken(
      current,
      input.accessToken ?? host?.accessToken ?? "",
      input.accessTokenReference ??
        (input.accessToken === undefined ? host?.accessTokenReference : undefined),
    );
    const credential = yield* resolveExpoCredential(saved);
    const viewer = yield* makeExpoApi(yield* HttpClient.HttpClient, credential).viewer;
    return { signedInAs: viewer.name, credentialSource: credential.source, apps: viewer.apps };
  },
  Effect.mapError(
    (cause) =>
      new DeviceEasAccountError({
        reason:
          cause._tag === "ExpoApiError"
            ? cause.status === 401 || cause.status === 403
              ? `Expo rejected the credential (HTTP ${cause.status}).`
              : cause.rejected
                ? "Expo refused the account check."
                : "Could not complete the Expo account check."
            : cause.message,
      }),
  ),
);
