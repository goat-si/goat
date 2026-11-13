import { describe, expect, it } from "@effect/vitest";

import { deriveLinkRows, type LinkStatusRow } from "./HubLinkTraffic.ts";
import { makeLinkTrafficBook, SLOT_MS } from "./linkTrafficBook.ts";

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT_MS);
const thresholds = { deviceBytes: 0, hubBytes: 0 };
const pen = new Set(["pen-mini"]);
const row = (overrides: Partial<LinkStatusRow> = {}, toHomeBytes = 0, toHomeUncounted = 0) =>
  ({
    id: "lnk_a",
    alias: "pen-mini",
    tunnelPort: 54001,
    state: "connected",
    direction: "hub-initiated",
    traffic: { epoch: "ab", generation: 1, toHomeBytes, fromHomeBytes: 0, toHomeUncounted },
    ...overrides,
  }) as LinkStatusRow;

describe("deriveLinkRows", () => {
  it("never classifies a client-initiated link's route, since the Home opens no SSH for it", () => {
    const book = makeLinkTrafficBook();
    const [client] = deriveLinkRows(
      book,
      [row({ direction: "client-initiated" })],
      T0,
      pen,
      thresholds,
    ).links;
    expect(client?.route).toBeUndefined();
    const [hub] = deriveLinkRows(makeLinkTrafficBook(), [row()], T0, pen, thresholds).links;
    expect(hub?.route).toEqual({ name: "pen-mini", via: "relay" });
  });

  it("marks traffic as HTTP bodies only while a link WebSocket is open, since its payloads are not counted", () => {
    const book = makeLinkTrafficBook();
    const ws = { ws: { open: 1 } };
    deriveLinkRows(book, [row(ws, 0)], T0, pen, thresholds);
    const [link] = deriveLinkRows(book, [row(ws, 1_000)], T0 + 60_000, pen, thresholds).links;
    expect(link).toMatchObject({ transport: "websocket", traffic: { httpBodiesOnly: true } });
  });

  it("carries requests whose body OpenCodex could not count into the window", () => {
    const book = makeLinkTrafficBook();
    deriveLinkRows(book, [row({}, 0, 1)], T0, pen, thresholds);
    const [link] = deriveLinkRows(book, [row({}, 1_000, 4)], T0 + 60_000, pen, thresholds).links;
    expect(link?.traffic?.day.uncountedRequests).toBe(3);
  });

  it("an older reading recorded after a newer one counts nothing twice", () => {
    const book = makeLinkTrafficBook();
    deriveLinkRows(book, [row({}, 0)], T0, pen, thresholds);
    deriveLinkRows(book, [row({}, 2_000)], T0 + 120_000, pen, thresholds);
    // A slower read that started at T0 + 60 s answers last.
    deriveLinkRows(book, [row({}, 1_000)], T0 + 60_000, pen, thresholds);
    const [link] = deriveLinkRows(book, [row({}, 3_000)], T0 + 180_000, pen, thresholds).links;
    expect(link?.traffic?.day.toHomeBytes).toBe(3_000);
  });

  it("keeps saying HTTP bodies only after the WebSocket closes, while that time is still in the window", () => {
    const book = makeLinkTrafficBook();
    deriveLinkRows(book, [row({ ws: { open: 1 } }, 0)], T0, pen, thresholds);
    deriveLinkRows(book, [row({ ws: { open: 0 } }, 1_000)], T0 + 60_000, pen, thresholds);
    const [closed] = deriveLinkRows(
      book,
      [row({ ws: { open: 0 } }, 2_000)],
      T0 + 120_000,
      pen,
      thresholds,
    ).links;
    expect(closed?.traffic?.httpBodiesOnly).toBe(true);
    deriveLinkRows(book, [row({ ws: { open: 0 } }, 3_000)], T0 + 12 * 3_600_000, pen, thresholds);
    const [later] = deriveLinkRows(
      book,
      [row({ ws: { open: 0 } }, 4_000)],
      T0 + 24 * 3_600_000 + 10 * 60_000,
      pen,
      thresholds,
    ).links;
    expect(later?.traffic).toBeDefined();
    expect(later?.traffic?.httpBodiesOnly).toBeUndefined();
  });

  it("remembers WebSocket time across a counter reset, so traffic that pairs later still says HTTP bodies only", () => {
    const book = makeLinkTrafficBook();
    const at = (generation: number, bytes: number, open: number) =>
      row({
        ws: { open },
        traffic: { epoch: "ab", generation, toHomeBytes: bytes, fromHomeBytes: 0 },
      });
    deriveLinkRows(book, [at(0, 0, 1)], T0, pen, thresholds);
    deriveLinkRows(book, [at(1, 100, 0)], T0 + 60_000, pen, thresholds);
    const [link] = deriveLinkRows(book, [at(1, 500, 0)], T0 + 120_000, pen, thresholds).links;
    expect(link?.traffic?.day.toHomeBytes).toBe(400);
    expect(link?.traffic?.httpBodiesOnly).toBe(true);
  });
});
