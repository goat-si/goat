import type {
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshots,
} from "@goat/contracts";
export function instanceHubs(
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
): UsageLimitSourceSnapshots {
  const endpoint = provider.auth.endpoint;
  return endpoint === undefined ? [] : sources.filter((source) => source.origin === endpoint);
}

// Antigravity meters Gemini Argon, Gemini Carbon, other Gemini, and Claude/GPT models apart.
function antigravityQuotaFamily(id: string) {
  if (!id.startsWith("gemini")) return "shared";
  return id.includes("argon") ? "argon" : id.includes("carbon") ? "carbon" : "gemini";
}

/** Each Antigravity quota blocks only the models it meters. */
export function antigravityWindowLimitsModel(
  window: Pick<ServerProviderUsageWindow, "id">,
  model: string | null,
): boolean {
  // A hub can prefix model ids, such as "ag/gemini-3.1-pro".
  const base = model?.slice(model.lastIndexOf("/") + 1);
  // An alias such as "fast" may route to either quota, so both hold it back.
  if (base === undefined || !/^(gemini|claude|gpt)/.test(base)) return true;
  return antigravityQuotaFamily(window.id) === antigravityQuotaFamily(base);
}

/** The hub accounts that serve a model: those that list it, else every account of the driver. */
export function hubRoutes(
  sources: UsageLimitSourceSnapshots,
  driver: ServerProvider["driver"],
  model: string | null,
): (account: UsageLimitSourceAccount) => boolean {
  // Claude Code's 1M-context suffix is not part of the model id a hub routes.
  const full = model?.replace(/\[1m\]$/i, "");
  // The hub routes a thinking suffix such as "gpt-5.2(high)" by its base model when one lists it.
  const base = full?.replace(/\([^)]*\)$/, "");
  const lists = (id: string | undefined) =>
    sources.some((source) => source.accounts.some((account) => account.models?.includes(id ?? "")));
  const slug = lists(base) ? base : full;
  const listed = (account: UsageLimitSourceAccount) =>
    slug !== undefined && account.models?.includes(slug) === true;
  const serving = new Set(
    sources.flatMap((source) => source.accounts.filter(listed).map((account) => account.driver)),
  );
  // Model ids such as "opus" are aliases no hub lists, so no listing falls back to the driver.
  if (serving.size === 0)
    return (account) => account.driver === driver && account.models?.length !== 0;
  // An account whose model list was unreadable may serve the model too.
  return (account) =>
    account.models ? listed(account) : serving.has(account.driver) || account.driver === driver;
}
