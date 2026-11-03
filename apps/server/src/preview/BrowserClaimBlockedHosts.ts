import { isBlockedBrowserUrl } from "@goat/shared/preview";

export const blockedClaimCall = (
  name: string,
  args: unknown,
  hosts: ReadonlyArray<string>,
  claims: ReadonlyArray<{
    readonly claimId: string;
    readonly claimGeneration: number;
    readonly origin: string;
    readonly tab: { readonly tabId: string };
  }>,
) => {
  if (!(name.startsWith("browser_") || name === "get_browser_state" || name === "page")) return {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const input = args as Record<string, unknown>;
  const claim = claims.find((entry) => entry.tab.tabId === input.tab_id);
  if (!claim) return {};
  if (isBlockedBrowserUrl(claim.origin, hosts)) return { blocked: true, claim };
  if (typeof input.url === "string" && isBlockedBrowserUrl(input.url, hosts))
    return { blocked: true };
  return {};
};
