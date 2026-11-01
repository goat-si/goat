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

/** Opt-in Home route for Claude Code, OpenCode and Pi; omitted fields are the default route. */
export const ProviderHomeRouteFields = {
  modelRoute: Schema.optionalKey(CodexModelRoute).pipe(
    Schema.annotateKey({
      title: "Model route",
      description:
        "OpenCodex Home uses Home's accounts and shared quota. If Home is unavailable, requests fail. Pi uses an isolated GOAT configuration while routed.",
      providerSettingsForm: {
        control: "select",
        options: [
          { value: "default", label: "Provider settings" },
          { value: "opencodex", label: "OpenCodex Home" },
        ],
        clearWhenEmpty: "omit",
      },
    }),
  ),
  opencodexBaseUrl: Schema.optionalKey(TrimmedString).pipe(
    Schema.annotateKey({
      title: "OpenCodex address",
      description:
        "Local address on the machine running this instance, such as http://127.0.0.1:10100/v1. Remote Home is reached through that machine's OpenCodex link.",
      providerSettingsForm: { placeholder: DEFAULT_OPENCODEX_BASE_URL, clearWhenEmpty: "omit" },
    }),
  ),
  /** Set by each approved connect so a reconnect rebuilds the runtime from Home's catalog. */
  opencodexRouteRevision: Schema.optionalKey(TrimmedNonEmptyString).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
};
/** Reads the route from any of those configs, applying the defaults an older config omits. */
export const ProviderHomeRouteConfig = Schema.Struct({
  modelRoute: CodexModelRoute.pipe(Schema.withDecodingDefault(Effect.succeed("default" as const))),
  opencodexBaseUrl: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_OPENCODEX_BASE_URL)),
  ),
  opencodexRouteRevision: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderHomeRouteConfig = typeof ProviderHomeRouteConfig.Type;

/** Observed only after a routed runtime was prepared; it is not an inference receipt. */
export const ProviderHomeRouteStatus = Schema.Struct({
  modelRoute: CodexModelRoute,
  effectiveBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderHomeRouteStatus = typeof ProviderHomeRouteStatus.Type;

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
