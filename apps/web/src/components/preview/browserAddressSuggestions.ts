// Suggestion matching adapted from Emanuele-web04/synara @ 566efb1b1
// (apps/web/src/components/BrowserPanel.logic.ts).
// Copyright (c) 2026 T3 Tools Inc. Copyright (c) 2026 Emanuele Di Pietro. MIT license.
import { addressBarSearchUrl, resolveAddressBarInput } from "@goat/shared/preview";

export type BrowserAddressTab = { tabId: string; url: string; title: string };
export type BrowserAddressSuggestion = {
  id: string;
  url: string;
  title: string;
} & ({ kind: "navigate" | "history" } | { kind: "tab"; tabId: string });

const BROWSER_ADDRESS_SUGGESTION_LIMIT = 6;

function pageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Matches the whole scoped tab/history set before applying the display limit. */
export function buildBrowserAddressSuggestions(input: {
  query: string;
  currentUrl: string;
  activeTabId: string | null;
  tabs: ReadonlyArray<BrowserAddressTab>;
  history: ReadonlyArray<{ url: string; title?: string }>;
}): BrowserAddressSuggestion[] {
  const query = input.query.trim().toLowerCase();
  const suggestions: BrowserAddressSuggestion[] = [];
  const seen = new Set([pageUrl(input.currentUrl)]);
  const push = (suggestion: BrowserAddressSuggestion) => {
    const url = pageUrl(suggestion.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    suggestions.push({ ...suggestion, url });
  };
  if (query) {
    try {
      const url = resolveAddressBarInput(input.query);
      push({
        id: `navigate:${url}`,
        kind: "navigate",
        url,
        title:
          url === addressBarSearchUrl(input.query)
            ? `Search for “${input.query.trim()}”`
            : `Go to ${url}`,
      });
    } catch {
      // Unsupported schemes still allow matching an existing page's title.
    }
  }
  const matches = (entry: { url: string; title?: string }) =>
    `${entry.title ?? ""} ${entry.url}`.toLowerCase().includes(query);
  for (const tab of input.tabs) {
    if (tab.tabId === input.activeTabId || !matches(tab)) continue;
    push({ ...tab, id: `tab:${tab.tabId}`, kind: "tab", title: tab.title || tab.url });
  }
  for (const entry of input.history) {
    if (!matches(entry)) continue;
    push({
      ...entry,
      id: `history:${entry.url}`,
      kind: "history",
      title: entry.title || entry.url,
    });
  }
  return suggestions.slice(0, BROWSER_ADDRESS_SUGGESTION_LIMIT);
}
