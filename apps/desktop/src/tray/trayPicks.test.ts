import { describe, expect, it } from "vite-plus/test";

import { createTrayPicks, type TrayPick } from "./trayPicks.ts";

function renderer() {
  const received: TrayPick[] = [];
  return {
    received,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(_channel: string, pick: TrayPick) {
      received.push(pick);
    },
  };
}

const pick = (threadId: string): TrayPick => ({ environmentId: "local", threadId });

describe("createTrayPicks", () => {
  it("holds a pick made before any renderer listens and delivers it once", () => {
    const picks = createTrayPicks<ReturnType<typeof renderer>>("open");
    const window = renderer();
    picks.pick(pick("a"));
    picks.listening(window);
    picks.listening(window);
    expect(window.received).toEqual([pick("a")]);
  });

  it("keeps a pick made during a reload for the reloaded renderer, newest pick winning", () => {
    const picks = createTrayPicks<ReturnType<typeof renderer>>("open");
    const before = renderer();
    picks.listening(before);
    expect(picks.gone(before)).toBe(true);
    picks.pick(pick("a"));
    picks.pick(pick("b"));
    const after = renderer();
    picks.listening(after);
    expect(before.received).toEqual([]);
    expect(after.received).toEqual([pick("b")]);
  });

  it("does not send to a destroyed renderer", () => {
    const picks = createTrayPicks<ReturnType<typeof renderer>>("open");
    const window = renderer();
    picks.listening(window);
    window.destroyed = true;
    picks.pick(pick("a"));
    expect(window.received).toEqual([]);
    expect(picks.gone(renderer())).toBe(false);
  });
});
