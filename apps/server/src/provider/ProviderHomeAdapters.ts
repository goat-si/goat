import {
  ClaudeSettings,
  CodexSettings,
  ProviderHomeRouteConfig,
  type ProviderHomeRequestInput,
  type ProviderInstanceConfig,
} from "@goat/contracts";
import { OpenCodeSettings } from "@goat/provider-opencode/settings";
import { PiSettings } from "@goat/provider-pi/settings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { normalizeOpenCodexBaseUrl } from "./OpenCodexRoute.ts";

type ProviderHomeDriver = "codex" | "claudeAgent" | "opencode" | "pi";
/** Drivers GOAT routes only on an explicit request; Codex keeps its own route builder. */
export type ProviderHomeOverlayDriver = Exclude<ProviderHomeDriver, "codex">;

export const supportsProviderHome = (driver: string | undefined): driver is ProviderHomeDriver =>
  driver === "codex" || driver === "claudeAgent" || driver === "opencode" || driver === "pi";
const OVERLAY_DRIVERS = ["claudeAgent", "opencode", "pi"] as const;
export const providerHomeOverlayDriver = (driver: string | undefined) =>
  OVERLAY_DRIVERS.find((kind) => kind === driver);

export const providerHomeLabel = (driver: string) =>
  driver === "claudeAgent"
    ? "Claude Code"
    : driver === "opencode"
      ? "OpenCode"
      : driver === "pi"
        ? "Pi"
        : "Codex";

/** Variables the routed runtime overlay replaces; their stored values change the route. */
const PROVIDER_HOME_OVERLAY_ENV: Record<ProviderHomeOverlayDriver, ReadonlyArray<string>> = {
  claudeAgent: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "GOAT_CLAUDE_HOME_ROUTE",
  ],
  opencode: ["OPENCODE_CONFIG_CONTENT", "OPENCODEX_API_KEY"],
  pi: ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"],
};

class ProviderHomeConfigError extends Schema.TaggedError<ProviderHomeConfigError>()(
  "ProviderHomeConfigError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
const configError = (detail: string) => new ProviderHomeConfigError({ detail });
const readRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeRoute = Schema.decodeUnknownOption(ProviderHomeRouteConfig);
const decodeRouteEffect = Schema.decodeUnknownEffect(ProviderHomeRouteConfig);
const decodeCodex = Schema.decodeEffect(CodexSettings);
const decodeClaude = Schema.decodeEffect(ClaudeSettings);
const decodeOpenCode = Schema.decodeEffect(OpenCodeSettings);
const decodePi = Schema.decodeEffect(PiSettings);

/** Validates the configuration with the captured driver's own schema; no other driver is trusted. */
const decodeProviderHomeConfig = Effect.fn("ProviderHomeAdapters.decode")(function* (
  instance: ProviderInstanceConfig,
) {
  const config = instance.config ?? {};
  const invalid = () => configError("This instance's settings are invalid. Fix them in Settings.");
  switch (instance.driver) {
    case "codex":
      return yield* decodeCodex(config).pipe(Effect.mapError(invalid));
    case "claudeAgent":
      return yield* decodeClaude(config).pipe(Effect.mapError(invalid));
    case "opencode":
      return yield* decodeOpenCode(config).pipe(Effect.mapError(invalid));
    case "pi":
      return yield* decodePi(config).pipe(Effect.mapError(invalid));
    default:
      return yield* configError("This driver cannot route through OpenCodex Home.");
  }
});

/**
 * The stored configuration with only the route changed. Unrelated stored keys, including secret
 * references, are written back untouched. Disconnect keeps the stored address.
 */
export const changeProviderHomeConfig = Effect.fn("ProviderHomeAdapters.change")(function* (
  instance: ProviderInstanceConfig,
  input: ProviderHomeRequestInput,
  /** Records an approved connect, so reconnecting a routed instance still rebuilds its runtime. */
  routeRevision?: string,
) {
  yield* decodeProviderHomeConfig(instance);
  const stored = Option.getOrUndefined(readRecord(instance.config ?? {}));
  if (stored === undefined) return yield* configError("This instance's settings are invalid.");
  if (input.action === "disconnect") return { ...stored, modelRoute: "default" as const };
  const route = yield* decodeRouteEffect(stored).pipe(
    Effect.mapError(() => configError("This instance's Home route settings are invalid.")),
  );
  const opencodexBaseUrl = yield* Effect.try({
    try: () => normalizeOpenCodexBaseUrl(input.opencodexBaseUrl ?? route.opencodexBaseUrl),
    catch: () => configError("Enter a local OpenCodex address such as http://127.0.0.1:10100/v1."),
  });
  return {
    ...stored,
    modelRoute: "opencodex" as const,
    opencodexBaseUrl,
    ...(routeRevision === undefined || providerHomeOverlayDriver(instance.driver) === undefined
      ? {}
      : { opencodexRouteRevision: routeRevision }),
  };
});

const canonicalUrl = (value: string) => {
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    return `invalid:${value}`;
  }
};

/** Route identity an active Claude Code, OpenCode or Pi use fences; Codex uses codexRouteKey. */
export const providerHomeRouteKey = (instance: ProviderInstanceConfig | undefined) => {
  const driver = providerHomeOverlayDriver(instance?.driver);
  if (driver === undefined) return undefined;
  const route = decodeRoute(instance?.config ?? {});
  if (Option.isNone(route)) return `${driver}:invalid`;
  const overlaid = PROVIDER_HOME_OVERLAY_ENV[driver];
  const environment = (instance?.environment ?? [])
    .filter(({ name }) => overlaid.includes(name))
    .map(({ name, value }) => [name, value] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    driver,
    route.value.modelRoute,
    canonicalUrl(route.value.opencodexBaseUrl),
    route.value.opencodexRouteRevision ?? null,
    environment,
  ]);
};
