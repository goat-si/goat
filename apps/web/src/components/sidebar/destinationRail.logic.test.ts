import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RAIL_PREFERENCES,
  moveRailItem,
  orderRailItems,
  railPreferencesForHydration,
  RAIL_ITEM_IDS,
  resolveActiveDestination,
  resolveRailItems,
  setRailItemShown,
  type RailContext,
  type RailPreferences,
} from "./destinationRail.logic";

const notBot = { isBotRoute: false } as const;

describe("resolveActiveDestination", () => {
  it.each([
    ["/", "home"],
    ["/env-1/thread-1", "home"],
    ["/draft/draft-1", "home"],
    ["/new", "home"],
    ["/fleet", "fleet"],
    ["/decisions", "decisions"],
    ["/usage", "usage"],
    ["/pull-requests", "pullRequests"],
    ["/notes", "notes"],
    ["/settings/memory", "memory"],
    ["/settings/scheduled-tasks", "scheduled"],
    ["/settings/hub", "hub"],
    ["/settings", "settings"],
    ["/settings/appearance", "settings"],
    ["/settings/memory-import", "settings"],
    ["/projects/goat", "settings"],
  ] as const)("maps %s to %s", (pathname, expected) => {
    expect(resolveActiveDestination(pathname, notBot)).toBe(expected);
  });

  it("keeps Bot selected after /bot redirects to the bot thread", () => {
    expect(resolveActiveDestination("/bot", { isBotRoute: true })).toBe("bot");
    expect(resolveActiveDestination("/env-1/bot-thread", { isBotRoute: true })).toBe("bot");
  });
});

const singleMachine: RailContext = {
  environmentCount: 1,
  pullRequestsSupported: true,
  memoryAvailable: true,
  hubEnabled: false,
  canAddProvider: true,
  primaryProviderReady: true,
};

const shownIds = (preferences: RailPreferences, context: RailContext) =>
  resolveRailItems(preferences, context)
    .filter((item) => item.shown)
    .map((item) => item.id);

describe("resolveRailItems", () => {
  it("shows the everyday destinations on a single machine with a working provider", () => {
    expect(shownIds(DEFAULT_RAIL_PREFERENCES, singleMachine)).toEqual([
      "bot",
      "decisions",
      "usage",
      "pullRequests",
      "memory",
      "scheduled",
    ]);
  });

  it("adds Fleet with a second machine and Hub on a hub", () => {
    const shown = shownIds(DEFAULT_RAIL_PREFERENCES, {
      ...singleMachine,
      environmentCount: 2,
      hubEnabled: true,
    });
    expect(shown).toContain("fleet");
    expect(shown).toContain("hub");
  });

  it("offers Add provider only once providers have loaded and none is ready", () => {
    const shownFor = (primaryProviderReady: boolean | null) =>
      shownIds(DEFAULT_RAIL_PREFERENCES, { ...singleMachine, primaryProviderReady });
    expect(shownFor(false)).toContain("addProvider");
    expect(shownFor(null)).not.toContain("addProvider");
    expect(shownFor(true)).not.toContain("addProvider");
  });

  it("keeps an item the person turned on when its context default turns off", () => {
    const preferences = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "addProvider", true);
    expect(shownIds(preferences, { ...singleMachine, primaryProviderReady: false })).toContain(
      "addProvider",
    );
    expect(shownIds(preferences, { ...singleMachine, primaryProviderReady: true })).toContain(
      "addProvider",
    );
  });

  it("keeps an item the person hid even when context would show it", () => {
    const preferences = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "fleet", false);
    expect(shownIds(preferences, { ...singleMachine, environmentCount: 3 })).not.toContain("fleet");
  });

  it("does not show an unavailable item but keeps the person's choice for later", () => {
    const preferences = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "pullRequests", true);
    const unsupported = resolveRailItems(preferences, {
      ...singleMachine,
      pullRequestsSupported: false,
    }).find((item) => item.id === "pullRequests");
    expect(unsupported).toMatchObject({ shown: false, available: false, choice: "shown" });
    expect(shownIds(preferences, singleMachine)).toContain("pullRequests");
  });

  it("switching a choice replaces the earlier one", () => {
    const hidden = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "notes", false);
    const shown = setRailItemShown(hidden, "notes", true);
    expect(shown.hidden).not.toContain("notes");
    expect(shown.shown).toEqual(["notes"]);
  });
});

describe("rail order", () => {
  it("drops unknown and repeated ids and appends missing items in default order", () => {
    expect(orderRailItems(["notes", "future-item", "notes", "bot"])).toEqual([
      "notes",
      "bot",
      ...RAIL_ITEM_IDS.filter((id) => id !== "notes" && id !== "bot"),
    ]);
  });

  it("moves an item one step and keeps other versions' ids", () => {
    const moved = moveRailItem(
      { ...DEFAULT_RAIL_PREFERENCES, order: ["future-item"] },
      "usage",
      -1,
    );
    const order = orderRailItems(moved.order);
    expect(order.indexOf("usage")).toBe(RAIL_ITEM_IDS.indexOf("decisions"));
    expect(moved.order).toContain("future-item");
  });

  it.each([
    ["fleet", -1],
    ["addProvider", 1],
  ] as const)("leaves %s in place at the edge", (id, delta) => {
    expect(moveRailItem(DEFAULT_RAIL_PREFERENCES, id, delta)).toBe(DEFAULT_RAIL_PREFERENCES);
  });

  it("composes consecutive moves and toggles", () => {
    let preferences = moveRailItem(DEFAULT_RAIL_PREFERENCES, "notes", -1);
    preferences = moveRailItem(preferences, "notes", -1);
    preferences = setRailItemShown(preferences, "notes", true);
    const items = resolveRailItems(preferences, singleMachine).map((item) => item.id);
    expect(items.indexOf("notes")).toBe(RAIL_ITEM_IDS.indexOf("notes") - 2);
    expect(shownIds(preferences, singleMachine)).toContain("notes");
  });
});

describe("railPreferencesForHydration", () => {
  const saved = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "bot", false);

  it.each([
    ["pending", null],
    ["retrying", null],
    ["ready", saved],
    ["failed", DEFAULT_RAIL_PREFERENCES],
  ] as const)("uses %s settings as %o", (status, expected) => {
    expect(railPreferencesForHydration(status, saved)).toBe(expected);
  });
});
