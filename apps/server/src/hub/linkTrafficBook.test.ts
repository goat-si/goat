import { describe, expect, it } from "@effect/vitest";

import { makeLinkTrafficBook, SLOT_MS, type LinkTrafficReading } from "./linkTrafficBook.ts";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT_MS);
const reading = (
  bytes: number,
  options: {
    epoch?: string;
    generation?: number;
    route?: LinkTrafficReading["route"];
    linkId?: string;
  } = {},
): LinkTrafficReading => ({
  linkId: options.linkId ?? "link-a",
  traffic: {
    epoch: options.epoch ?? "e1",
    generation: options.generation ?? 1,
    toHomeBytes: bytes,
    fromHomeBytes: Math.floor(bytes / 4),
  },
  route: options.route,
});
const relay = { name: "pen-mac", via: "relay" } as const;
const direct = { name: "mac-lan", via: "direct" } as const;

describe("link traffic book", () => {
  it("never subtracts readings from another epoch or generation (counter reset)", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(1_000)], T0);
    book.observe([reading(400, { epoch: "e2" })], T0 + 60_000);
    expect(book.view("link-a", T0 + 60_000)).toBeUndefined();
    book.observe([reading(900, { epoch: "e2", generation: 2 })], T0 + 120_000);
    expect(book.view("link-a", T0 + 120_000)).toBeUndefined();
    book.observe([reading(1_500, { epoch: "e2", generation: 2 })], T0 + 180_000);
    expect(book.view("link-a", T0 + 180_000)?.day).toMatchObject({
      toHomeBytes: 600,
      measuredMs: 60_000,
    });
  });

  it("ignores counters that went backward under the same epoch and generation", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(1_000)], T0);
    book.observe([reading(10)], T0 + 60_000);
    expect(book.view("link-a", T0 + 60_000)).toBeUndefined();
  });

  it("sums a gap between readers exactly and spreads it over the hour it covers", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(0)], T0);
    book.observe([reading(7_200_000)], T0 + 2 * HOUR);
    const view = book.view("link-a", T0 + 2 * HOUR);
    expect(view?.day).toEqual({
      toHomeBytes: 7_200_000,
      fromHomeBytes: 1_800_000,
      relayToHomeBytes: 0,
      relayFromHomeBytes: 0,
      directToHomeBytes: 0,
      directFromHomeBytes: 0,
      measuredMs: 2 * HOUR,
    });
    expect(view?.hour).toMatchObject({ toHomeBytes: 3_600_000, measuredMs: HOUR });
  });

  it("counts relay bytes only while both readings had the same Pen route in use", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(0, { route: relay })], T0);
    book.observe([reading(1_000, { route: relay })], T0 + 60_000);
    book.observe([reading(3_000, { route: direct })], T0 + 120_000);
    book.observe([reading(3_500, { route: relay })], T0 + 180_000);
    book.observe([reading(4_500)], T0 + 240_000);
    expect(book.view("link-a", T0 + 240_000)?.day).toMatchObject({
      toHomeBytes: 4_500,
      relayToHomeBytes: 1_000,
      relayFromHomeBytes: 250,
    });
  });

  it("drops bytes older than 24 hours from both windows", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(0)], T0);
    book.observe([reading(1_000)], T0 + HOUR);
    book.observe([reading(1_000)], T0 + 2 * HOUR);
    const at = T0 + 25.5 * HOUR;
    book.observe([reading(1_000)], at);
    expect(book.view("link-a", at)?.day).toMatchObject({ toHomeBytes: 0, measuredMs: 24 * HOUR });
  });

  it("keeps a removed link's relay bytes in the hub total for a day, then forgets it", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(0, { route: relay }), reading(0, { route: relay, linkId: "b" })], T0);
    book.observe(
      [reading(1_000, { route: relay }), reading(3_000, { route: relay, linkId: "b" })],
      T0 + 60_000,
    );
    book.observe([reading(1_000, { route: relay })], T0 + 120_000);
    expect(book.relayDayBytes(T0 + 120_000)).toBe(1_250 + 3_750);
    book.observe([reading(1_000, { route: relay })], T0 + 25 * HOUR);
    expect(book.size()).toBe(1);
  });

  it("holds at most its bound of links, dropping the one read longest ago", () => {
    const book = makeLinkTrafficBook(2);
    book.observe([reading(0, { linkId: "a" }), reading(0, { linkId: "b" })], T0);
    book.observe([reading(0, { linkId: "a" })], T0 + 1);
    book.observe([reading(0, { linkId: "c" })], T0 + 2);
    expect(book.size()).toBe(2);
    book.observe([reading(500, { linkId: "a" }), reading(500, { linkId: "b" })], T0 + 60_000);
    expect(book.view("a", T0 + 60_000)?.day.toHomeBytes).toBe(500);
    expect(book.view("b", T0 + 60_000)).toBeUndefined();
  });

  it("keeps a stable set of links when more than its bound report each pass, so they still pair", () => {
    const book = makeLinkTrafficBook(2);
    const pass = (bytes: number, at: number) =>
      book.observe(
        ["a", "b", "c"].map((linkId) => reading(bytes, { linkId })),
        at,
      );
    pass(0, T0);
    pass(600, T0 + 60_000);
    const measured = ["a", "b", "c"].filter((id) => book.view(id, T0 + 60_000) !== undefined);
    expect(measured).toHaveLength(2);
    expect(book.size()).toBe(2);
  });
  it("counts direct bytes only while both readings had the same direct route; the rest has no confirmed route", () => {
    const book = makeLinkTrafficBook();
    book.observe([reading(0, { route: direct })], T0);
    book.observe([reading(1_000, { route: direct })], T0 + 60_000);
    book.observe([reading(3_000, { route: { name: "pen-mac" } })], T0 + 120_000);
    book.observe([reading(3_400, { route: { name: "pen-mac" } })], T0 + 180_000);
    expect(book.view("link-a", T0 + 180_000)?.day).toMatchObject({
      toHomeBytes: 3_400,
      relayToHomeBytes: 0,
      directToHomeBytes: 1_000,
      directFromHomeBytes: 250,
    });
  });
});
