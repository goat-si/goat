import type { ServerProvider, ServerProviderState } from "@goat/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodexAppServerProviderSnapshot } from "./CodexProvider.ts";

function codexAccountAuthLabel(
  account: CodexSchema.V2GetAccountResponse["account"],
  usagePlanType: string | null | undefined,
) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;
  // account/read takes the plan from the cached login token; the usage read asks the backend.
  const usageLabel = usagePlanType === "unknown" ? undefined : codexPlanLabel(usagePlanType);
  return usageLabel ?? codexPlanLabel(account.planType);
}

export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 200 Subscription";
    case "prolite":
      return "ChatGPT Pro 100 Subscription";
    case "promax":
      return "ChatGPT Pro 500 Subscription";
    case "self_serve_business_prolite":
      return "ChatGPT Business Premium Subscription";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

// Codex keeps `requiresOpenaiAuth` for its built-in provider even when `openai_base_url` sends
// requests elsewhere (OpenCodex); the missing login stays decisive for OpenAI or unverified endpoints.
const CodexRoutingConfig = Schema.Struct({
  model_provider: Schema.optionalKey(Schema.NullOr(Schema.String)),
  openai_base_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_providers: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ base_url: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
const decodeCodexRoutingConfig = Schema.decodeUnknownOption(CodexRoutingConfig);

// Null is Codex's auth-dependent OpenAI default; undefined is a route that cannot be read.
function codexRouteBaseUrl(config: unknown): string | null | undefined {
  const decoded = decodeCodexRoutingConfig(config);
  if (Option.isNone(decoded)) return undefined;
  const routing = decoded.value;
  const providerId = routing.model_provider ?? "openai";
  if (providerId === "openai") return routing.openai_base_url || null;
  const provider = routing.model_providers?.[providerId];
  return provider ? (provider.base_url ?? null) : undefined;
}

function routesToNativeOpenai(config: unknown): boolean {
  const baseUrl = codexRouteBaseUrl(config);
  if (baseUrl === undefined) return false;
  if (baseUrl === null) return true;
  if (!URL.canParse(baseUrl)) return false;
  const url = new URL(baseUrl);
  return (
    url.protocol === "https:" &&
    (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com")
  );
}

/** The origin of the custom endpoint Codex sends model requests to, if it uses one. */
export function codexCustomEndpoint(config: unknown): string | undefined {
  const baseUrl = codexRouteBaseUrl(config);
  const url = baseUrl ? URL.parse(baseUrl) : null;
  return url && /^https?:$/.test(url.protocol) && !routesToNativeOpenai(config)
    ? url.origin
    : undefined;
}

/** The configured endpoint, else the OpenCodex Home route's, which GOAT sets outside the config. */
export function codexEndpoint(
  config: unknown,
  effectiveBaseUrl: string | undefined,
): string | undefined {
  const custom = codexCustomEndpoint(config);
  if (custom !== undefined || !routesAwayFromOpenAi(effectiveBaseUrl)) return custom;
  const url = URL.parse(effectiveBaseUrl ?? "");
  return url && /^https?:$/.test(url.protocol) ? url.origin : undefined;
}

// A stored login does not mean this provider's traffic spends that login's quota.
export const codexRoutesSpendNativeQuota = (
  account: CodexSchema.V2GetAccountResponse,
  config: unknown,
): boolean =>
  account.requiresOpenaiAuth && account.account?.type !== "apiKey" && routesToNativeOpenai(config);

export function routesAwayFromOpenAi(effectiveBaseUrl: string | undefined): boolean {
  const host = URL.parse(effectiveBaseUrl ?? "")?.hostname.replace(/\.+$/, "");
  return (
    !!host &&
    !["openai.com", "chatgpt.com"].some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

export function accountProbeStatus(
  { account, rateLimits, effectiveBaseUrl }: CodexAppServerProviderSnapshot,
  codexHome?: string,
): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(
    account.account,
    rateLimits && "snapshot" in rateLimits ? rateLimits.snapshot.planType : undefined,
  );
  const authEmail = codexAccountEmail(account.account);
  const workspaceId =
    rateLimits && "accountId" in rateLimits ? rateLimits.accountId?.trim() : undefined;
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth && !routesAwayFromOpenAi(effectiveBaseUrl)) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: codexHome
        ? `Codex CLI is not authenticated. Run \`codex login\` with CODEX_HOME set to ${JSON.stringify(codexHome)} and try again.`
        : "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}
