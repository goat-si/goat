import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export function normalizeBlockedBrowserHost(value: string): string | null {
  const input = value.trim();
  if (!input || /[\s/@?#\\]/u.test(input)) return null;
  if (input.startsWith("[") ? !/^\[[\da-f:.]+\]$/i.test(input) : input.includes(":")) return null;
  try {
    return new URL(`http://${input}/`).hostname.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

const BlockedBrowserHost = Schema.String.check(
  Schema.makeFilter((value) => normalizeBlockedBrowserHost(value) !== null),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => normalizeBlockedBrowserHost(value) ?? value,
      encode: (value) => value,
    }),
  ),
);

export const BlockedBrowserSettingsFields = {
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  blockedBrowserHosts: Schema.Array(BlockedBrowserHost).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
};
export const BlockedBrowserSettingsPatchFields = {
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  blockedBrowserHosts: Schema.optionalKey(Schema.Array(BlockedBrowserHost)),
};
