import { describe, expect, it } from "@effect/vitest";
import type { DesktopCuaFrame, DesktopCuaFrames } from "@goat/contracts";

import type { HelperFrame } from "./ComputerUseHelper.ts";
import { makeFrameFollower } from "./frameFollower.ts";

const target = { key: "desktop:control:a", pid: 7, windowId: 3, maxWidth: 320, intervalMs: 500 };
const request = (
  seq: number,
  targets: DesktopCuaFrames["targets"] = [target],
): DesktopCuaFrames => ({
  version: 1,
  type: "cuaFrames",
  seq,
  targets,
});

/** A helper session that records frames requests and lets the test send frames back. */
function fakeSession(
  calls: Array<string>,
  name: string,
  options: { readonly canFrame?: boolean; readonly fail?: number } = {},
) {
  let listener: ((frame: HelperFrame) => void) | undefined;
  let failures = options.fail ?? 0;
  let last = 0;
  return {
    canFrame: options.canFrame ?? true,
    frames: async (framesId: number, targets: DesktopCuaFrames["targets"]) => {
      calls.push(name + ":frames:" + framesId + ":" + targets.length);
      if (targets.length > 0) last = framesId;
      if (failures-- > 0) throw new Error("timed out");
    },
    onFrame: (next: (frame: HelperFrame) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    send: (framesId: number) =>
      listener?.({
        type: "frame",
        framesId,
        key: target.key,
        width: 320,
        height: 200,
        data: "QUJD",
      }),
    /** A late frame of the last request that named a window. */
    sendLast: () =>
      listener?.({
        type: "frame",
        framesId: last,
        key: target.key,
        width: 320,
        height: 200,
        data: "QUJD",
      }),
  };
}

const follow = () => {
  const published: Array<DesktopCuaFrame> = [];
  const retries: Array<() => void> = [];
  const follower = makeFrameFollower({
    publish: (frame) => published.push(frame),
    retryLater: (retry) => retries.push(retry),
  });
  return { follower, published, retries };
};

describe("frameFollower", () => {
  it("asks the running helper for the server's windows and forwards only the current request's frames", async () => {
    const calls: Array<string> = [];
    const { follower, published } = follow();
    const helper = fakeSession(calls, "h1");
    await follower.attach(helper);
    await follower.setRequest(request(4));
    expect(calls).toEqual(["h1:frames:1:1"]);
    helper.send(1);
    await follower.setRequest(request(5, []));
    // A frame of the stopped request still in the pipe never reaches the server.
    helper.send(1);
    expect(calls).toEqual(["h1:frames:1:1", "h1:frames:2:0"]);
    expect(published).toEqual([
      {
        version: 1,
        type: "cuaFrame",
        seq: 4,
        key: target.key,
        width: 320,
        height: 200,
        mime: "image/jpeg",
        data: "QUJD",
      },
    ]);
  });

  it("answers unsupported for a helper built before frames, without asking it", async () => {
    const calls: Array<string> = [];
    const { follower, published } = follow();
    await follower.attach(fakeSession(calls, "old", { canFrame: false }));
    await follower.setRequest(request(2));
    expect(calls).toEqual([]);
    expect(published).toEqual([
      { version: 1, type: "cuaFrameUnavailable", seq: 2, key: target.key, reason: "unsupported" },
    ]);
  });

  it("answers captureFailed when the request fails, retries, and asks a new helper generation again", async () => {
    const calls: Array<string> = [];
    const { follower, published, retries } = follow();
    await follower.attach(fakeSession(calls, "h1", { fail: 1 }));
    await follower.setRequest(request(6));
    expect(published).toEqual([
      { version: 1, type: "cuaFrameUnavailable", seq: 6, key: target.key, reason: "captureFailed" },
    ]);
    retries.shift()?.();
    await follower.setRequest(request(6));
    expect(calls).toEqual(["h1:frames:1:1", "h1:frames:2:1"]);
    follower.detach();
    await follower.attach(fakeSession(calls, "h2"));
    expect(calls.at(-1)).toBe("h2:frames:3:1");
  });

  it("stops capturing when the server goes away, though a server that comes back counts again from 1", async () => {
    const calls: Array<string> = [];
    const { follower, published } = follow();
    const helper = fakeSession(calls, "h1");
    await follower.attach(helper);
    await follower.setRequest(request(6));
    const before = calls.length;
    // The publisher's clear when its server detaches.
    await follower.setRequest(request(0, []));
    expect(calls.slice(before)).toEqual([expect.stringMatching(/^h1:frames:\d+:0$/)]);
    helper.sendLast();
    expect(published).toEqual([]);
    follower.detach();
    await follower.attach(fakeSession(calls, "h2"));
    await follower.setRequest(request(1, []));
    expect(calls.filter((call) => call.startsWith("h2") && !call.endsWith(":0"))).toEqual([]);
  });
});
