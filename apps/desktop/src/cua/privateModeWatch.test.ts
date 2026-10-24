import { describe, expect, it } from "@effect/vitest";
import type { DesktopCuaPrivateModeReport } from "@goat/contracts";

import type { HelperEvent } from "./ComputerUseHelper.ts";
import { makePrivateModeFollower } from "./privateModeWatch.ts";

/** A helper session that records watch calls and lets the test raise events. */
function fakeSession(
  calls: Array<string>,
  name: string,
  options: { readonly canWatch?: boolean; readonly failWatches?: number } = {},
) {
  let listener: ((event: HelperEvent["event"]) => void) | undefined;
  let failures = options.failWatches ?? 0;
  return {
    canWatch: options.canWatch ?? true,
    watch: async (watchId: string) => {
      calls.push(name + ":watch:" + watchId);
      if (failures-- > 0) throw new Error("timed out");
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

const follow = (overrides: Partial<Parameters<typeof makePrivateModeFollower>[0]> = {}) => {
  let ids = 0;
  const retries: Array<() => void> = [];
  const follower = makePrivateModeFollower({
    publish: () => undefined,
    newWatchId: () => "w" + ++ids,
    retryLater: (retry) => retries.push(retry),
    ...overrides,
  });
  return { follower, retries };
};

describe("private mode follower", () => {
  it("watches only while agents control the host, and again on each new helper", async () => {
    const calls: Array<string> = [];
    const { follower } = follow();
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

  it("never asks a helper that cannot watch", async () => {
    const calls: Array<string> = [];
    const { follower } = follow();
    await follower.attach(fakeSession(calls, "old", { canWatch: false }));
    await follower.setWatching(true);
    await follower.setWatching(false);
    expect(calls).toEqual([]);
  });

  it("after a watch that failed, retries it and still stops whatever the helper may run", async () => {
    const calls: Array<string> = [];
    const { follower, retries } = follow();
    await follower.attach(fakeSession(calls, "a", { failWatches: 1 }));
    await follower.setWatching(true);
    // The failed watch may have started anyway: it is retried while agents still control the host.
    expect(retries).toHaveLength(1);
    retries[0]?.();
    // Still watching: the queued retry runs before this settles.
    await follower.setWatching(true);
    await follower.setWatching(false);
    // And it is stopped once they no longer do, even had the retry failed as well.
    const again = follow();
    const failing: Array<string> = [];
    await again.follower.attach(fakeSession(failing, "b", { failWatches: 1 }));
    await again.follower.setWatching(true);
    await again.follower.setWatching(false);
    expect(calls).toEqual(["a:watch:w1", "a:watch:w2", "a:unwatch"]);
    expect(failing).toEqual(["b:watch:w1", "b:unwatch"]);
  });

  it("reports a secret field's focus and clears it when its helper goes away", async () => {
    const reports: Array<DesktopCuaPrivateModeReport> = [];
    const { follower } = follow({ publish: (report) => reports.push(report) });
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
