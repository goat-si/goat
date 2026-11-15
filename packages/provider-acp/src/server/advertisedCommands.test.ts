import { describe, expect, it } from "vite-plus/test";

import * as AdvertisedCommands from "./advertisedCommands.ts";

describe("advertised ACP commands", () => {
  it("keeps only the session that advertised last, so retention stays bounded", () => {
    let advertised = AdvertisedCommands.remember("session-1", [{ name: " Compact " }]);
    expect(AdvertisedCommands.advertises(advertised, "session-1", "compact")).toBe(true);
    for (let index = 2; index <= 100; index += 1) {
      advertised = AdvertisedCommands.remember(`session-${index}`, [{ name: "plan" }]);
    }
    expect(advertised).toEqual({ sessionId: "session-100", names: new Set(["plan"]) });
    expect(AdvertisedCommands.advertises(advertised, "session-1", "compact")).toBe(false);
    expect(AdvertisedCommands.advertises(null, "session-1", "compact")).toBe(false);
  });
});
