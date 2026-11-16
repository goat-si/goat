import { describe, expect, it } from "vite-plus/test";

import * as AdvertisedCommands from "./advertisedCommands.ts";

const rememberAll = (sessionIds: ReadonlyArray<string>, name: string) =>
  sessionIds.reduce(
    (advertised, sessionId) => AdvertisedCommands.remember(advertised, sessionId, [{ name }]),
    AdvertisedCommands.empty,
  );

describe("advertised ACP commands", () => {
  it("keeps the last 8 sessions that advertised, oldest out, so retention stays bounded", () => {
    let advertised = AdvertisedCommands.remember(AdvertisedCommands.empty, "session-1", [
      { name: " Compact " },
    ]);
    expect(AdvertisedCommands.advertises(advertised, "session-1", "compact")).toBe(true);
    for (let index = 2; index <= 100; index += 1) {
      advertised = AdvertisedCommands.remember(advertised, `session-${index}`, [{ name: "plan" }]);
    }
    expect([...advertised.keys()]).toEqual(
      Array.from({ length: 8 }, (_, index) => `session-${93 + index}`),
    );
    expect(AdvertisedCommands.advertises(advertised, "session-1", "compact")).toBe(false);
    expect(AdvertisedCommands.advertises(advertised, "session-100", "plan")).toBe(true);
  });

  it("with no announcement, no session advertises /compact", () => {
    expect(AdvertisedCommands.advertises(AdvertisedCommands.empty, "session-1", "compact")).toBe(
      false,
    );
  });

  it("a child session that announces late leaves the parent's /compact in place", () => {
    const parent = AdvertisedCommands.remember(AdvertisedCommands.empty, "parent", [
      { name: "compact" },
    ]);
    const withChild = AdvertisedCommands.remember(parent, "child", [{ name: "plan" }]);
    expect(AdvertisedCommands.advertises(withChild, "parent", "compact")).toBe(true);
    expect(AdvertisedCommands.advertises(withChild, "child", "compact")).toBe(false);
  });

  it("a resumed session that does not announce again keeps what it announced before", () => {
    const before = AdvertisedCommands.remember(AdvertisedCommands.empty, "resumed", [
      { name: "compact" },
    ]);
    const afterOthers = rememberAll(["other-1", "other-2"], "plan");
    const resumed = [...afterOthers].reduce(
      (advertised, [sessionId, names]) =>
        AdvertisedCommands.remember(
          advertised,
          sessionId,
          [...names].map((name) => ({ name })),
        ),
      before,
    );
    expect(AdvertisedCommands.advertises(resumed, "resumed", "compact")).toBe(true);
  });

  it("announcing again moves a session to the newest slot and replaces its commands", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => `session-${index}`);
    const full = rememberAll(sessions, "compact");
    const refreshed = AdvertisedCommands.remember(full, "session-0", [{ name: "plan" }]);
    const next = AdvertisedCommands.remember(refreshed, "session-8", [{ name: "compact" }]);
    expect(AdvertisedCommands.advertises(next, "session-0", "compact")).toBe(false);
    expect(AdvertisedCommands.advertises(next, "session-0", "plan")).toBe(true);
    expect(AdvertisedCommands.advertises(next, "session-1", "compact")).toBe(false);
    expect(next.size).toBe(8);
  });
});
