import { describe, expect, it } from "@effect/vitest";
import type { DesktopCuaPrivateModeReport } from "@goat/contracts";

import type { HelperEvent } from "./ComputerUseHelper.ts";
import { makePrivateModeFollower } from "./privateModeWatch.ts";

/** A helper session that records watch calls and lets the test raise events. */
function fakeSession(calls: Array<string>, name: string) {
  let listener: ((event: HelperEvent["event"]) => void) | undefined;
  return {
    watch: async (watchId: string) => {
      calls.push(name + ":watch:" + watchId);
    },
    unwatch: async () => {
      calls.push(name + ":unwatch");
    },
    onEvent: (next: (event: HelperEvent["event"]) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    raise: (active: boolean, windowId: number) =>
      listener?.({ type: "privateMode", active, target: { pid: 7, windowId } }),
  };
}

describe("private mode follower", () => {
  it("watches only while agents control the host, and again on each new helper", async () => {
    const calls: Array<string> = [];
    let ids = 0;
    const follower = makePrivateModeFollower({
      publish: () => undefined,
      newWatchId: () => "w" + ++ids,
    });
    const first = fakeSession(calls, "a");
    await follower.attach(first);
    // No agent yet: nothing is watched.
    expect(calls).toEqual([]);
    await follower.setWatching(true);
    await follower.setWatching(false);
    await follower.setWatching(true);
    follower.detach();
    await follower.attach(fakeSession(calls, "b"));
    expect(calls).toEqual(["a:watch:w1", "a:unwatch", "a:watch:w2", "b:watch:w3"]);
  });

  it("reports a secret field's focus and clears it when its helper goes away", async () => {
    const reports: Array<DesktopCuaPrivateModeReport> = [];
    const follower = makePrivateModeFollower({
      publish: (report) => reports.push(report),
      newWatchId: () => "w",
    });
    const session = fakeSession([], "a");
    await follower.attach(session);
    await follower.setWatching(true);
    // A watch's first state with no secret field focused says nothing to clear.
    session.raise(false, 0);
    session.raise(true, 3);
    follower.detach();
    // A late event from the gone helper is not heard.
    session.raise(true, 4);
    expect(reports.map(({ active, target }) => ({ active, windowId: target.windowId }))).toEqual([
      { active: true, windowId: 3 },
      { active: false, windowId: 3 },
    ]);
  });
});
