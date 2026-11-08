import type { ServerProvider, ServerProviderState } from "@goat/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
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
export function routesAwayFromOpenAi(effectiveBaseUrl: string | undefined): boolean {
  const host = URL.parse(effectiveBaseUrl ?? "")?.hostname.replace(/\.+$/, "");
  return (
    !!host &&
    !["openai.com", "chatgpt.com"].some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

export function accountProbeStatus({
  account,
  rateLimits,
  effectiveBaseUrl,
}: CodexAppServerProviderSnapshot): {
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
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}
