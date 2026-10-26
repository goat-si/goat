import type { KeepRule, PathRule, TextRule } from "./engine.ts";
import { isTest } from "./paths.ts";

/**
 * GOAT Connect: the disabled Connect stack and its relay (infra/relay) use GOAT names. No GOAT relay was ever
 * deployed, so headers, token types, client ids, worker and dataset names change freely. Values that saved data
 * holds stay in packages/contracts/src/legacyT3Names.ts. Plan: devlog/_plan/261026_goat-identity-cleanup/030.
 */
const inRelay = (path: string) => path.startsWith("infra/relay/");

const rule = (
  id: string,
  find: RegExp,
  replace: string,
  scope?: (path: string) => boolean,
): TextRule => ({
  id: "relay:" + id,
  category: "relay",
  find,
  replace,
  ...(scope ? { scope } : {}),
});

const at =
  (...paths: readonly string[]) =>
  (path: string): boolean =>
    paths.includes(path);

/**
 * Sentences that contrast the old stack with GOAT Connect. They run before visible-connect-account-copy, which
 * would otherwise turn them into "GOAT Connect will replace GOAT Connect".
 */
export const CONNECT_CONTRAST_RULES: readonly TextRule[] = [
  rule(
    "contrast-shared",
    /(?<=will replace )T3 Connect/g,
    "upstream's Connect stack",
    at("packages/shared/src/goatConnect.ts"),
  ),
  rule(
    "contrast-remote-access",
    /(?<=coming soon\. )T3 Connect(?= sign-in)/g,
    "Upstream's Connect",
    at("docs/user/remote-access.md"),
  ),
  rule(
    "contrast-mobile-readme",
    /(?<=coming soon\. )T3 Connect(?= is disabled)/g,
    "Upstream's Connect stack",
    at("apps/mobile/README.md"),
  ),
  rule(
    "contrast-android",
    /(?<=These steps need )T3 Connect(?=, which is disabled)/g,
    "the previous Connect stack",
    at("docs/operations/android-notifications.md"),
  ),
  rule(
    "upstream-publishable-key",
    /\bT3's existing production publishable key\b/g,
    "upstream's existing production publishable key",
    at("docs/operations/android-notifications.md"),
  ),
  rule(
    "upstream-services",
    /\bexisting T3 services\b/g,
    "existing upstream services",
    at("docs/operations/android-notifications.md"),
  ),
  rule(
    "contrast-testflight",
    /(?<=\*\*)T3 Connect(?= sign-in\*\* is off)/g,
    "Connect",
    at("docs/operations/mobile-testflight.md"),
  ),
];

const tracingFiles = (path: string) =>
  /(?:relayTracing|apps\/web\/src\/lib\/runtime|apps\/mobile\/src\/features\/observability\/tracing)\.ts$/.test(
    path,
  );

/** Relay client ids appear quoted; the cached-token reader keeps the legacy ids via legacyT3Names.ts. */
const clientIdFiles = (path: string) =>
  path === "packages/contracts/src/relay.ts" ||
  path.startsWith("packages/client-runtime/src/relay/") ||
  path.startsWith("apps/mobile/src/features/cloud/") ||
  path.startsWith("apps/web/src/cloud/") ||
  inRelay(path);

const datasetFiles = (path: string) =>
  inRelay(path) ||
  path === ".env.example" ||
  path === "docs/operations/relay-observability.md" ||
  path === "docs/operations/connect-setup.md";

export const RELAY_TEXT_RULES: readonly TextRule[] = [
  rule("headers", /\bx-t3-(relay-[a-z-]*|hook-outcome)/g, "x-goat-$1"),
  rule("endpoint-kind", /\bt3_relay\b/g, "goat_relay"),
  rule("jwt-typ", /\bt3-(env|cloud|relay|link)-([a-z-]+\+jwt)\b/g, "goat-$1-$2"),
  rule("env-issuer", /(?<=[\x60"'])t3-env:/g, "goat-env:"),
  rule("client-ids", /(?<=")t3-(mobile|web)(?=")/g, "goat-$1", clientIdFiles),
  rule("trace-surface", /\bt3\.client\.surface\b/g, "goat.client.surface"),
  rule("trace-component", /\bt3code\.component\b/g, "goat.component"),
  rule("trace-namespace", /(?<="service\.namespace": ")t3code(?=")/g, "goat"),
  rule("service-names", /\bt3code-(server|desktop|web|mobile)\b/g, "goat-$1", tracingFiles),
  rule("service-short-names", /(?<=")t3-(server|web)(?=")/g, "goat-$1", tracingFiles),
  rule(
    "datasets",
    /\bt3-code-(relay(?:-client)?|mobile)(-[a-z0-9-]+)?\b/g,
    "goat-$1$2",
    datasetFiles,
  ),
  rule("package", /\bt3code-relay\b/g, "goat-relay"),
  // GOAT chooses the Clerk JWT template name when it deploys.
  rule("jwt-template", /(?<=[`="'\s])t3-relay(?=[`"'\s]|$)/g, "goat-relay"),
  rule("trace-client-surface", /\bt3code\.client\.surface\b/g, "goat.client.surface"),
  rule("relay-product", /\bT3 Code\b/g, "GOAT", inRelay),
  rule(
    "showcase-tmp",
    /\bt3-mobile-showcase-/g,
    "goat-mobile-showcase-",
    at("scripts/mobile-showcase.ts"),
  ),
  rule("tunnel-prefix", /\bt3coderelay(?=-managedendpoint|\b)/g, "goatrelay"),
  rule("credential-prefix", /\bt3env_/g, "goatenv_", inRelay),
  rule(
    "stage-sample",
    /\bdev([-_])julius\b/g,
    "dev$1alex",
    (path) => inRelay(path) || path === "docs/operations/relay-observability.md",
  ),
  // Pinned tunnel hashes digest the stage name, so they follow the stage sample rename.
  ...(
    [
      ["d101ac68108a423e", "fe70a0e4f4b8eb87"],
      ["d7e6356aaf8863aa", "388b28a52f055d1a"],
      ["a2fc84ac1b8c1c35", "c416de8b81d55645"],
    ] as const
  ).map(([from, to]) =>
    rule(
      "stage-sample-hash-" + to,
      new RegExp(from, "g"),
      to,
      at("infra/relay/src/environments/ManagedEndpointProvider.test.ts"),
    ),
  ),
  rule("api-path", /(?<=\/api\/)t3-connect(?=\/)/g, "goat-connect"),
  // Only the internals guide moves; the user troubleshooting mirror keeps its path and anchors (help URLs).
  rule(
    "doc-links",
    /(?<=internals\/|\(\.\/)t3-connect(?=\.md\b)/g,
    "goat-connect",
    (path) => !path.startsWith("docs/user/"),
  ),
];

export const RELAY_PATH_RULES: readonly PathRule[] = [
  {
    id: "relay:internals-doc",
    category: "relay",
    find: /^docs\/internals\/t3-connect\.md$/g,
    replace: "docs/internals/goat-connect.md",
  },
];

const connectLiteralFiles = new Set([
  "apps/mobile/src/features/connection/environmentSections.ts",
  "apps/web/src/components/settings/EnvironmentRow.logic.ts",
  "packages/client-runtime/src/connection/catalog.ts",
  "packages/client-runtime/src/connection/catalogHost.ts",
  "packages/client-runtime/src/connection/hubProxyAuthSource.ts",
  "packages/client-runtime/src/connection/resolver.ts",
  "packages/client-runtime/src/connection/routes.ts",
  "packages/contracts/src/connectionCatalog.ts",
]);

export const RELAY_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "relay:help-mirror",
    pattern: /[a-z-]*t3-connect[a-z-]*|\[T3 Connect troubleshooting\]/g,
    scope: (path) =>
      path === "docs/user/t3-connect-troubleshooting.md" ||
      path === "docs/README.md" ||
      path === "packages/client-runtime/src/connection/diagnosis.ts" ||
      path === "packages/contracts/src/environmentHttp.ts",
    reason:
      "Help URLs open upstream's troubleshooting page by heading anchor; GOAT hosts no user docs yet (W11).",
  },
  {
    id: "relay:migration-default-label",
    pattern: /"T3 Environment"/g,
    scope: (path) => path === "infra/relay/src/persistence/schema.ts",
    reason: "Matches the default in the relay's migration snapshots, which stay byte-stable.",
  },
  {
    id: "relay:hosted-web-routing",
    pattern: /(?:latest\.|nightly\.)?app\.t3\.codes|__t3code\/channel|t3code_web_channel/g,
    scope: (path) => path === "docs/operations/release.md",
    reason: "Upstream's hosted web router; removed with the hosted app default (wp4).",
  },
  {
    id: "relay:connect-persisted-literal",
    pattern: /(?<=["'])t3-connect(?=["'])/g,
    scope: (path) => connectLiteralFiles.has(path) || isTest(path),
    reason: "Saved connection routes and profiles hold this kind (LEGACY_CONNECT_ROUTE_KIND).",
  },
  {
    id: "relay:mobile-native-pending",
    pattern: /\bt3_kind\b|\bt3-agent-(?:activity|alerts?)\b/g,
    scope: inRelay,
    reason:
      "Installed Android builds read these push keys and tags; they move with the mobile native rename (wp6).",
  },
];
