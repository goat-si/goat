import { DEFAULT_OPENCODEX_BASE_URL, type CodexSettings } from "@goat/contracts";
import type * as Schema from "effect/Schema";
import { parse, stringify } from "smol-toml";

type RouteSettings = Pick<CodexSettings, "modelRoute" | "opencodexAuth" | "opencodexBaseUrl">;

// Codex 0.156.1 config/read reports unset provider keys as null; any other value, even {} or "",
// can carry a credential. Recheck this list against config/read when the pinned Codex changes.
const CREDENTIAL_KEYS = [
  "auth",
  "env_key",
  "http_headers",
  "env_http_headers",
  "experimental_bearer_token",
  "query_params",
  "gateway_oauth",
  "aws",
] as const;

export const usesAuthlessCodexHome = (settings: RouteSettings) =>
  settings.modelRoute === "opencodex" && settings.opencodexAuth === "none";

const codexHomeProvider = (baseUrl: string) => ({
  name: "OpenCodex",
  base_url: baseUrl,
  wire_api: "responses",
  requires_openai_auth: false,
});

/** The effective native table sends nothing but Home's own local endpoint. */
export const isAuthlessCodexHomeProvider = (
  provider: Readonly<Record<string, unknown>> | undefined,
  baseUrl: string,
) =>
  provider !== undefined &&
  provider.base_url === baseUrl &&
  provider.wire_api === "responses" &&
  provider.requires_openai_auth === false &&
  CREDENTIAL_KEYS.every((key) => provider[key] === undefined || provider[key] === null);

const scalar = (value: string | boolean) =>
  stringify({ value })
    .trim()
    .replace(/^value\s*=\s*/, "");

/** Reads the TOML right-hand side of a `-c key=value` argument. */
export const decodeCodexHomeCatalogArg = (value: string): unknown => {
  try {
    return parse(`value=${value}`).value;
  } catch {
    return undefined;
  }
};

export const codexHomeRouteArgv = (
  settings: RouteSettings,
  baseUrl: string,
  catalogPath: string,
): ReadonlyArray<string> => {
  const routing = usesAuthlessCodexHome(settings)
    ? [
        'model_provider="opencodex"',
        `model_providers.opencodex={${Object.entries(codexHomeProvider(baseUrl))
          .map(([key, value]) => `${key}=${scalar(value)}`)
          .join(",")}}`,
      ]
    : ['model_provider="openai"', `openai_base_url=${scalar(baseUrl)}`];
  return [...routing, `model_catalog_json=${scalar(catalogPath)}`].flatMap((value) => [
    "-c",
    value,
  ]);
};

/** Native thread overrides for the current Home provider; other routes send none. */
export const codexHomeThreadOverrides = (settings: RouteSettings) => {
  if (settings.modelRoute !== "opencodex") return {};
  const authless = usesAuthlessCodexHome(settings);
  const modelProvider = authless ? "opencodex" : "openai";
  const baseUrl = new URL(settings.opencodexBaseUrl.trim() || DEFAULT_OPENCODEX_BASE_URL)
    .toString()
    .replace(/\/+$/, "");
  return {
    modelProvider,
    config: {
      model_provider: modelProvider,
      ...(authless ? { "model_providers.opencodex": codexHomeProvider(baseUrl) } : {}),
    },
  };
};

/** Native start, resume and fork use the instance's current Home provider. */
export const mergeCodexHomeThreadParams = <
  T extends { readonly config: Readonly<Record<string, Schema.Json>> },
>(
  settings: RouteSettings,
  params: T,
): T & { readonly modelProvider?: string } => {
  const overrides = codexHomeThreadOverrides(settings);
  return "config" in overrides
    ? { ...params, ...overrides, config: { ...params.config, ...overrides.config } }
    : params;
};
