import { assert, it } from "@effect/vitest";
import {
  trackCodexWebSearch,
  MAX_TRACKED_WEB_SEARCHES,
  MAX_WEB_SEARCH_BYTES,
} from "./CodexWebSearchTracker.ts";

it("evicts the oldest unfinished searches while retaining recent entries", () => {
  const tracked = new Map();
  for (let i = 0; i <= MAX_TRACKED_WEB_SEARCHES; i++)
    trackCodexWebSearch(tracked, { id: `search-${i}`, type: "webSearch", query: "goat" });
  assert.equal(tracked.size, MAX_TRACKED_WEB_SEARCHES);
  assert.isFalse(tracked.has("search-0"));
  assert.equal(tracked.get(`search-${MAX_TRACKED_WEB_SEARCHES}`)?.query, "goat");
});

it("bounds retained search payloads even for huge Unicode queries and query lists", () => {
  const tracked = new Map();
  trackCodexWebSearch(tracked, {
    id: "huge",
    type: "webSearch",
    query: "🦊".repeat(MAX_WEB_SEARCH_BYTES),
    action: {
      type: "search",
      queries: Array.from({ length: 1000 }, () => "한".repeat(10000)),
      query: "test",
    },
  });
  const item = tracked.get("huge");
  assert.isDefined(item);
  assert.isAtMost(new TextEncoder().encode(JSON.stringify(item)).length, MAX_WEB_SEARCH_BYTES);
  const escapedId = "\u0000".repeat(256);
  trackCodexWebSearch(tracked, { id: escapedId, type: "webSearch", query: "\u0001".repeat(10000) });
  assert.isAtMost(
    new TextEncoder().encode(JSON.stringify(tracked.get(escapedId))).length,
    MAX_WEB_SEARCH_BYTES,
  );
});

it("preserves all search patterns when the payload fits within the byte limit", () => {
  const tracked = new Map();
  const original = {
    id: "fits",
    type: "webSearch" as const,
    query: "x".repeat(1200),
    action: {
      type: "search" as const,
      queries: Array.from({ length: 40 }, (_, i) => `query-${i}`),
    },
  };
  trackCodexWebSearch(tracked, original);
  assert.deepEqual(tracked.get("fits"), original);
});
