import { describe, expect, it } from "vite-plus/test";

import { buildBrowserAddressSuggestions } from "./browserAddressSuggestions";

const defaults = { query: "", currentUrl: "", activeTabId: null, tabs: [], history: [] };

describe("buildBrowserAddressSuggestions", () => {
  it("excludes blank, invalid and current URLs, including equivalent URL spellings", () => {
    const suggestions = buildBrowserAddressSuggestions({
      ...defaults,
      currentUrl: "https://example.com",
      history: ["about:blank", "", "javascript:alert(1)", "https://EXAMPLE.com:443/"].map(
        (url) => ({ url }),
      ),
    });
    expect(suggestions).toEqual([]);
  });

  it("deduplicates direct navigation, tabs and history in that order", () => {
    const suggestions = buildBrowserAddressSuggestions({
      ...defaults,
      query: "example.com",
      tabs: [
        { tabId: "1", url: "https://example.com/", title: "Home" },
        { tabId: "2", url: "https://example.com/docs", title: "Docs" },
        { tabId: "3", url: "https://example.com/docs", title: "Duplicate" },
      ],
      history: [{ url: "https://example.com/docs" }, { url: "https://example.com/recent" }],
    });
    expect(suggestions.map(({ kind, url }) => [kind, url])).toEqual([
      ["navigate", "https://example.com/"],
      ["tab", "https://example.com/docs"],
      ["history", "https://example.com/recent"],
    ]);
  });

  it("filters the whole history before limiting and matches titles case-insensitively", () => {
    const suggestions = buildBrowserAddressSuggestions({
      ...defaults,
      query: "  NEEDLE  ",
      history: [
        ...Array.from({ length: 40 }, (_, i) => ({ url: `https://example.com/${i}` })),
        { url: "https://example.com/old", title: "The needle" },
      ],
    });
    expect(suggestions.map(({ kind }) => kind)).toEqual(["navigate", "history"]);
    expect(suggestions[0]?.url).toBe("https://duckduckgo.com/?q=NEEDLE");
    expect(suggestions[1]?.title).toBe("The needle");
  });

  it("keeps open tabs ahead of history and bounds the list to six results", () => {
    const suggestions = buildBrowserAddressSuggestions({
      ...defaults,
      tabs: Array.from({ length: 10 }, (_, i) => ({
        tabId: `${i}`,
        url: `https://example.com/${i}`,
        title: "",
      })),
      history: [{ url: "https://example.com/recent" }],
    });
    expect(suggestions).toHaveLength(6);
    expect(suggestions.every((entry) => entry.kind === "tab")).toBe(true);
    expect(suggestions[0]?.title).toBe("https://example.com/0");
  });

  it("excludes the active tab even when a navigation update changes its URL", () => {
    expect(
      buildBrowserAddressSuggestions({
        ...defaults,
        activeTabId: "active",
        tabs: [{ tabId: "active", url: "https://example.com/new", title: "Redirecting" }],
      }),
    ).toEqual([]);
  });

  it("does not normalize path case, fragments or separate origins into duplicate pages", () => {
    const history = [
      "https://example.com/Docs",
      "https://example.com/docs",
      "https://example.com/docs#api",
      "http://example.com/docs",
    ].map((url) => ({ url }));
    expect(buildBrowserAddressSuggestions({ ...defaults, history }).map(({ url }) => url)).toEqual(
      history.map(({ url }) => url),
    );
  });

  it("retains GOAT's loopback resolver and does not suggest unsupported schemes", () => {
    expect(buildBrowserAddressSuggestions({ ...defaults, query: "localhost:5173" })[0]?.url).toBe(
      "http://localhost:5173/",
    );
    expect(buildBrowserAddressSuggestions({ ...defaults, query: "ftp://example.com" })).toEqual([]);
  });
});
