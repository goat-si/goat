import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const DEFAULT_OPENCODEX_BASE_URL = "http://127.0.0.1:10100/v1";

/** "none" sends Home requests through an authless provider; absent keeps OpenAI authentication. */
export const CodexHomeAuth = Schema.Literals(["openai", "none"]);
export type CodexHomeAuth = typeof CodexHomeAuth.Type;

export const CodexHomeSettingsFields = {
  opencodexBaseUrl: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_OPENCODEX_BASE_URL)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  opencodexAuth: CodexHomeAuth.pipe(
    Schema.withDecodingDefault(Effect.succeed("openai" as const)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
};

export const CodexModelRoute = Schema.Literals(["default", "opencodex"]);
export type CodexModelRoute = typeof CodexModelRoute.Type;

export const OpenCodexRouteState = Schema.Literals([
  "connected",
  "home",
  "reconnecting",
  "failed",
  "not_linked",
  "not_running",
]);
export type OpenCodexRouteState = typeof OpenCodexRouteState.Type;

/** Observed on the Codex execution host; default routes omit Home state and label. */
export const CodexRouteStatus = Schema.Struct({
  modelRoute: CodexModelRoute,
  effectiveBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  state: Schema.optionalKey(OpenCodexRouteState),
  homeLabel: Schema.optionalKey(TrimmedNonEmptyString),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CodexRouteStatus = typeof CodexRouteStatus.Type;
