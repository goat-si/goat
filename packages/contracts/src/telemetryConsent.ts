import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A person's answer to sharing product usage data from this server. `undecided` sends nothing,
 * exactly like `declined`; clients ask while it is undecided.
 */
export const TelemetryConsent = Schema.Literals(["undecided", "granted", "declined"]);
export type TelemetryConsent = typeof TelemetryConsent.Type;

export const TelemetryConsentSettingsFields = {
  telemetryConsent: TelemetryConsent.pipe(
    Schema.withDecodingDefault(Effect.succeed("undecided" as const)),
  ),
};
export const TelemetryConsentSettingsPatchFields = {
  telemetryConsent: Schema.optionalKey(TelemetryConsent),
};
