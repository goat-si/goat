import { ProviderSetupError } from "@goat/contracts";
import type { SecretStoreError } from "../auth/ServerSecretStore.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Registration = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^oaiapp_/u)),
  subject: Schema.optionalKey(Schema.String),
  connectionLabel: Schema.optionalKey(Schema.String),
  sharingEnabled: Schema.optionalKey(Schema.Boolean),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  redirectUri: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}\/auth\/callback$/u),
    ),
  ),
});
const RegistrationProfiles = Schema.Struct({
  profiles: Schema.Array(Registration),
  lastClientId: Schema.NullOr(Schema.String),
});

export type Registration = typeof Registration.Type;
export type RegistrationProfiles = typeof RegistrationProfiles.Type;

export const decodeRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([RegistrationProfiles, Registration])),
);
export const encodeRegistration = Schema.encodeEffect(Schema.fromJsonString(RegistrationProfiles));
export const profileMethodId = (clientId: string) => `chatgpt-profile:${clientId}`;

export const removeIncompleteRegistration =
  (deps: {
    readonly readRegistrations: Effect.Effect<RegistrationProfiles, ProviderSetupError>;
    readonly readSessionClientIds: Effect.Effect<ReadonlySet<string>, ProviderSetupError>;
    readonly registrationStore: {
      readonly set: (bytes: Uint8Array) => Effect.Effect<unknown, SecretStoreError>;
    };
    readonly failure: (operation: string, detail: string) => ProviderSetupError;
  }) =>
  (methodId: string) =>
    Effect.gen(function* () {
      const saved = yield* deps.readRegistrations;
      const profile = saved.profiles.find((entry) => profileMethodId(entry.clientId) === methodId);
      const sessionClientIds = yield* deps.readSessionClientIds;
      if (!profile || profile.subject !== undefined || sessionClientIds.has(profile.clientId))
        return yield* deps.failure(
          "removeMethod",
          "Only incomplete ChatGPT connections can be removed.",
        );
      const profiles = saved.profiles.filter((entry) => entry.clientId !== profile.clientId);
      yield* encodeRegistration({
        profiles,
        lastClientId:
          saved.lastClientId === profile.clientId
            ? (profiles[0]?.clientId ?? null)
            : saved.lastClientId,
      }).pipe(
        Effect.flatMap((json) => deps.registrationStore.set(new TextEncoder().encode(json))),
        Effect.mapError(() =>
          deps.failure("removeMethod", "Could not remove the saved ChatGPT connection. Try again."),
        ),
      );
    });
