import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const SecretProviderSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
export const SecretProviderId = SecretProviderSlug.pipe(Schema.brand("SecretProviderId"));
export type SecretProviderId = typeof SecretProviderId.Type;
export const SecretReference = Schema.Struct({
  provider: SecretProviderId,
  reference: TrimmedNonEmptyString.check(Schema.isMaxLength(1024), Schema.isPattern(/^[^\r\n]+$/)),
});
export type SecretReference = typeof SecretReference.Type;
export const isSecretReference = Schema.is(SecretReference);
const ONE_PASSWORD_NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const ONE_PASSWORD_REFERENCE = new RegExp(
  String.raw`^op://${ONE_PASSWORD_NAME}(?:/${ONE_PASSWORD_NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`,
);
export const isOnePasswordReference = (value: string): boolean =>
  value.length <= 1024 && ONE_PASSWORD_REFERENCE.test(value);

export const SettingsSecretValue = Schema.Union([TrimmedString, SecretReference]);
export type SettingsSecretValue = typeof SettingsSecretValue.Type;
export function settingsSecretLiteral(value: SettingsSecretValue): string {
  if (typeof value !== "string") throw new Error("Secret reference has not been resolved");
  return value;
}
