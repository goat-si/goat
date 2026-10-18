import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DEFAULT_OPENCODEX_BASE_URL = "http://127.0.0.1:10100/v1";

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
