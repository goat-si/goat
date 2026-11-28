// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createHostFromLocation } from "./HostProvider.tsx";

const loc = (search: string) => ({ search } as Location);

describe("host selection", () => {
  it("without a host config and without the prototype flag shows the real disconnected state", () => {
    delete window.goat2Host;
    const h = createHostFromLocation(loc(""));
    const s = h.client.getSnapshot();
    expect(s.connection).toBe("closed");
    expect(s.demo).toBeNull();
    expect(Object.keys(s.state.cards)).toHaveLength(0);
  });
  it("uses the fake host only when asked for a scene", () => {
    const h = createHostFromLocation(loc("?fake=2R-1"));
    expect(h.client.getSnapshot().demo).toBe("2R-1");
    h.client.close();
  });
  it("desktop before the host is up (wsUrl null) shows the disconnected state with the stamp", () => {
    window.goat2Host = { wsUrl: null, token: "t", build: { commit: "53ef8fac777", branch: "goat2", builtAt: "now", dirty: false } };
    const h = createHostFromLocation(loc(""));
    expect(h.desktop).toBe(true);
    expect(h.build?.commit).toBe("53ef8fac777");
    expect(h.client.getSnapshot().connection).toBe("closed");
    delete window.goat2Host;
  });
  it("uses the preload config as the real host and marks desktop", () => {
    window.goat2Host = { wsUrl: "ws://127.0.0.1:1/ws", token: "t", build: { commit: "abc1234def", branch: "goat2", builtAt: "now" } };
    const h = createHostFromLocation(loc(""));
    expect(h.desktop).toBe(true);
    expect(h.build?.commit).toBe("abc1234def");
    expect(h.client.getSnapshot().demo).toBeNull();
    h.client.close();
    delete window.goat2Host;
  });
});
