import { isBlockedBrowserUrl } from "@goat/shared/preview";

export type ClaimBrowserUrlValidation =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | {
      readonly ok: false;
      readonly reason: "disallowed_scheme" | "invalid_url";
      readonly protocol?: string;
    };

export const validateClaimBrowserUrl = (
  rawUrl: string,
  baseOrigin?: string,
): ClaimBrowserUrlValidation => {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return { ok: false, reason: "invalid_url" };
  let parsed: URL;
  try {
    parsed = baseOrigin === undefined ? new URL(trimmed) : new URL(trimmed, baseOrigin);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "disallowed_scheme", protocol: parsed.protocol };
  return { ok: true, url: parsed.href, origin: parsed.origin };
};

export const isBlockedClaimUrl = (
  rawUrl: string,
  baseOrigin: string | undefined,
  hosts: ReadonlyArray<string>,
): boolean => {
  const checked = validateClaimBrowserUrl(rawUrl, baseOrigin);
  return checked.ok && isBlockedBrowserUrl(checked.url, hosts);
};

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
  if (typeof input.url === "string" && isBlockedClaimUrl(input.url, claim.origin, hosts))
    return { blocked: true };
  return {};
};
