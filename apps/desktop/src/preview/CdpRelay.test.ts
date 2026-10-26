import { describe, expect, it, vi } from "vite-plus/test";

import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
});

// Each relay reply resolves after a few microtasks; one macrotask lets them all land.
// oxlint-disable-next-line goat/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await settle();
    const attach = written.findIndex((message) => message["id"] === 1);
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "goat-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "goat-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    pending[1]!();
    await settle();
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await settle();
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session", undefined);
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "goat-preview-page",
    });
  });

  it("resumes paused child frames, so cross-site iframes run", async () => {
    const send = vi.fn(async () => ({}));
    const relay = createCdpRelayConnection(makeTarget(send), () => {});
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "goat-preview-page",
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "iframe-session",
      }),
    );
    await settle();
    expect(send.mock.calls).toEqual([
      ["Runtime.runIfWaitingForDebugger", {}, "iframe-session", undefined],
    ]);
  });

  // Playwright enables focus emulation on every page it connects to, and Chromium then
  // counts the guest as captured: a preview the panel hides keeps its timers unthrottled.
  it("acknowledges Playwright's focus emulation without forcing it onto the guest", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
        sessionId: "goat-preview-page",
      }),
    );
    await settle();
    expect(written).toEqual([{ id: 1, result: {}, sessionId: "goat-preview-page" }]);
    expect(send).not.toHaveBeenCalled();
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "goat-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await settle();
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await settle();
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "DOM.enable", sessionId: extra }));
    await settle();
    expect(send).toHaveBeenLastCalledWith("DOM.enable", {}, undefined, extra);
    written.length = 0;
    relay.event("Page.loadEventFired", { timestamp: 1 }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["goat-preview-page", extra]);
  });
});

/** Opens `count` extra page sessions, as Playwright's `newCDPSession` does. */
const openPageSessions = async (
  relay: ReturnType<typeof createCdpRelayConnection>,
  written: Array<Record<string, unknown>>,
  count: number,
) => {
  relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
  relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
  await settle();
  const browser = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
    .sessionId;
  const ids = Array.from({ length: count }, (_, index) => 100 + index);
  for (const id of ids)
    relay.receive(
      JSON.stringify({
        id,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browser,
      }),
    );
  await settle();
  const pages = ids.map(
    (id) => (written.find((m) => m["id"] === id)!["result"] as { sessionId: string }).sessionId,
  );
  return { browser, pages };
};

const makeScreencastRelay = async (count: number) => {
  const send = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({}));
  const written: Array<Record<string, unknown>> = [];
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  const relay = createCdpRelayConnection(makeTarget(send), (raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    written.push(message);
    if (typeof message["id"] === "number") {
      replies.get(message["id"])?.(message);
      replies.delete(message["id"]);
    }
  });
  const { browser, pages } = await openPageSessions(relay, written, count);
  let nextId = 1000;
  const command = async (
    method: string,
    sessionId: string,
    params: Record<string, unknown> = {},
  ) => {
    relay.receive(JSON.stringify({ id: ++nextId, method, params, sessionId }));
    await settle();
  };
  const request = (method: string, sessionId: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    const reply = new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve));
    relay.receive(JSON.stringify({ id, method, params, sessionId }));
    return reply;
  };
  /** The screencast commands the page received, in order. */
  const screencast = () =>
    send.mock.calls
      .filter(([method]) => method.startsWith("Page.") && method.includes("creencast"))
      .map(([method, params]) => [method, params]);
  /** Sessions a frame event reached. */
  const frameTo = (frame: Record<string, unknown>) => {
    written.length = 0;
    relay.event("Page.screencastFrame", frame, "");
    return written.map((message) => message["sessionId"]);
  };
  return { relay, send, written, browser, pages, command, request, screencast, frameTo };
};

const small = { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 600 };
const large = { format: "jpeg", quality: 80, maxWidth: 1600, maxHeight: 1200 };

describe("CDP relay screencasts", () => {
  it("keeps one screencast at the largest size while any viewer wants it", async () => {
    const { pages, command, screencast, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    await command("Page.startScreencast", second, large);
    expect(screencast()).toEqual([
      ["Page.startScreencast", small],
      ["Page.stopScreencast", {}],
      ["Page.startScreencast", large],
    ]);

    await command("Page.stopScreencast", first);
    expect(screencast()).toHaveLength(3);
    expect(frameTo({ sessionId: 2, data: "x" })).toEqual([second]);

    await command("Page.stopScreencast", second);
    expect(screencast().at(-1)).toEqual(["Page.stopScreencast", {}]);
    expect(frameTo({ sessionId: 2, data: "x" })).toEqual([]);
  });

  it("shrinks to the remaining viewers' size when the largest one leaves", async () => {
    const { pages, command, screencast } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    await command("Page.startScreencast", second, large);
    await command("Page.stopScreencast", second);
    expect(screencast().slice(-2)).toEqual([
      ["Page.stopScreencast", {}],
      ["Page.startScreencast", small],
    ]);
  });

  it("acks a frame to the page only once every viewer has", async () => {
    const { pages, command, send, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    await command("Page.startScreencast", second, small);
    const acks = () => send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck");

    expect(frameTo({ sessionId: 4, data: "x" })).toEqual([first, second]);
    await command("Page.screencastFrameAck", first, { sessionId: 4 });
    expect(acks()).toEqual([]);
    await command("Page.screencastFrameAck", second, { sessionId: 4 });
    expect(acks()).toEqual([["Page.screencastFrameAck", { sessionId: 4 }, undefined]]);
    // Chromium counts acks per screencast, so a surplus one would let frames outrun the viewers.
    await command("Page.screencastFrameAck", first, { sessionId: 4 });
    expect(acks()).toHaveLength(1);
  });

  it("releases the frames a viewer owed when it detaches without stopping", async () => {
    const { pages, browser, command, send, screencast, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    await command("Page.startScreencast", second, small);
    frameTo({ sessionId: 4, data: "x" });
    await command("Page.screencastFrameAck", first, { sessionId: 4 });
    await command("Target.detachFromTarget", browser, { sessionId: second });
    expect(send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 4 }, undefined);
    await command("Target.detachFromTarget", browser, { sessionId: first });
    expect(screencast().at(-1)).toEqual(["Page.stopScreencast", {}]);
  });

  it("acks nothing for a frame from a screencast that has since restarted", async () => {
    const { pages, command, send, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    const acks = () => send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck");
    await command("Page.startScreencast", first, small);
    frameTo({ sessionId: 4, data: "old" });
    await command("Page.startScreencast", second, large);
    await command("Page.screencastFrameAck", first, { sessionId: 4 });
    expect(acks()).toEqual([]);

    expect(frameTo({ sessionId: 5, data: "new" })).toEqual([first, second]);
    await command("Page.screencastFrameAck", first, { sessionId: 5 });
    await command("Page.screencastFrameAck", second, { sessionId: 5 });
    expect(acks()).toEqual([["Page.screencastFrameAck", { sessionId: 5 }, undefined]]);
  });

  it("releases the frame a viewer owed when it stops", async () => {
    const { pages, command, send, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    await command("Page.startScreencast", second, small);
    frameTo({ sessionId: 4, data: "x" });
    await command("Page.screencastFrameAck", second, { sessionId: 4 });
    await command("Page.stopScreencast", first);
    expect(send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toEqual([
      ["Page.screencastFrameAck", { sessionId: 4 }, undefined],
    ]);
  });

  it("keeps the other viewers' screencast when a larger start fails", async () => {
    const { pages, command, send, written, screencast, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    send.mockImplementation(async (method, params) => {
      if (method === "Page.startScreencast" && params["maxWidth"] === large.maxWidth)
        throw new Error("Screencast refused");
      return {};
    });
    await command("Page.startScreencast", second, large);
    expect(written.at(-1)).toEqual({
      id: expect.any(Number),
      error: expect.objectContaining({ message: "Screencast refused" }),
      sessionId: second,
    });
    expect(screencast().slice(-3)).toEqual([
      ["Page.stopScreencast", {}],
      ["Page.startScreencast", large],
      ["Page.startScreencast", small],
    ]);
    expect(frameTo({ sessionId: 6, data: "x" })).toEqual([first]);
  });

  it("keeps the acks owed for a frame that beats its start's reply", async () => {
    const { pages, command, send, frameTo } = await makeScreencastRelay(1);
    let replyToStart: (value: {}) => void = () => {};
    send.mockImplementationOnce(() => new Promise<{}>((resolve) => (replyToStart = resolve)));
    await command("Page.startScreencast", pages[0]!, small);
    expect(frameTo({ sessionId: 1, data: "x" })).toEqual([pages[0]]);
    replyToStart({});
    await settle();
    await command("Page.screencastFrameAck", pages[0]!, { sessionId: 1 });
    expect(send).toHaveBeenLastCalledWith("Page.screencastFrameAck", { sessionId: 1 }, undefined);
  });

  it("restarts the remaining viewers' screencast on their next command after a refused restart", async () => {
    const { pages, command, send, screencast, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await command("Page.startScreencast", first, small);
    send.mockImplementation(async (method) => {
      if (method === "Page.startScreencast") throw new Error("Screencast refused");
      return {};
    });
    await command("Page.startScreencast", second, large);
    expect(frameTo({ sessionId: 2, data: "x" })).toEqual([first]);
    send.mockImplementation(async () => ({}));
    await command("Page.startScreencast", first, small);
    expect(screencast().at(-1)).toEqual(["Page.startScreencast", small]);
  });

  it("stops the page's screencast when the relay closes", async () => {
    const { relay, pages, command, screencast } = await makeScreencastRelay(1);
    await command("Page.startScreencast", pages[0]!, small);
    relay.close();
    await settle();
    expect(screencast().at(-1)).toEqual(["Page.stopScreencast", {}]);
  });

  it("retries a failed last stop before starting the next viewer", async () => {
    const { pages, request, send, screencast } = await makeScreencastRelay(1);
    const viewer = pages[0]!;
    await request("Page.startScreencast", viewer, small);
    let failStop = true;
    send.mockImplementation(async (method) => {
      if (method === "Page.stopScreencast" && failStop) {
        failStop = false;
        throw new Error("Stop refused");
      }
      return {};
    });
    expect(await request("Page.stopScreencast", viewer)).toHaveProperty("error");
    await request("Page.startScreencast", viewer, small);
    expect(screencast().map(([method]) => method)).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast",
      "Page.stopScreencast",
      "Page.startScreencast",
    ]);
  });

  it("drops frames and acks while a restart is stopping the old screencast", async () => {
    const { pages, request, send, frameTo } = await makeScreencastRelay(2);
    const [first, second] = pages as [string, string];
    await request("Page.startScreencast", first, small);
    let enterStop!: () => void;
    const stopping = new Promise<void>((resolve) => (enterStop = resolve));
    let finishStop!: (result: {}) => void;
    send.mockImplementation((method) => {
      if (method === "Page.stopScreencast") {
        enterStop();
        return new Promise<{}>((resolve) => (finishStop = resolve));
      }
      return Promise.resolve({});
    });
    const restarted = request("Page.startScreencast", second, large);
    await stopping;
    expect(frameTo({ sessionId: 41, data: "old" })).toEqual([]);
    await request("Page.screencastFrameAck", first, { sessionId: 41 });
    expect(send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toEqual([]);
    finishStop({});
    await restarted;
  });

  it("keeps an existing viewer's old size and frames when its larger restart fails", async () => {
    const { pages, request, send, screencast, frameTo } = await makeScreencastRelay(1);
    const viewer = pages[0]!;
    await request("Page.startScreencast", viewer, small);
    send.mockImplementation(async (method, params) => {
      if (method === "Page.startScreencast" && params["maxWidth"] === large.maxWidth)
        throw new Error("Larger start refused");
      return {};
    });
    expect(await request("Page.startScreencast", viewer, large)).toHaveProperty("error");
    expect(screencast().at(-1)).toEqual(["Page.startScreencast", small]);
    expect(frameTo({ sessionId: 42, data: "x" })).toEqual([viewer]);
  });

  it("retries a failed last stop when the page streams another frame", async () => {
    const { pages, request, send, screencast, frameTo } = await makeScreencastRelay(1);
    const viewer = pages[0]!;
    await request("Page.startScreencast", viewer, small);
    let failStop = true;
    send.mockImplementation(async (method) => {
      if (method === "Page.stopScreencast" && failStop) {
        failStop = false;
        throw new Error("Stop refused");
      }
      return {};
    });
    expect(await request("Page.stopScreencast", viewer)).toHaveProperty("error");
    expect(frameTo({ sessionId: 43, data: "still streaming" })).toEqual([]);
    await request("DOM.enable", viewer);
    expect(screencast().filter(([method]) => method === "Page.stopScreencast")).toHaveLength(2);
  });

  it("does not restore a detached viewer after its pending restart fails", async () => {
    const { pages, browser, request, send, frameTo, screencast } = await makeScreencastRelay(1);
    const viewer = pages[0]!;
    await request("Page.startScreencast", viewer, small);
    let enterStart!: () => void;
    const starting = new Promise<void>((resolve) => (enterStart = resolve));
    let failStart!: (reason: Error) => void;
    send.mockImplementation((method, params) => {
      if (method === "Page.startScreencast" && params["maxWidth"] === large.maxWidth) {
        enterStart();
        return new Promise<{}>((_resolve, reject) => (failStart = reject));
      }
      return Promise.resolve({});
    });
    const restarted = request("Page.startScreencast", viewer, large);
    await starting;
    await request("Target.detachFromTarget", browser, { sessionId: viewer });
    failStart(new Error("Restart refused"));
    expect(await restarted).toHaveProperty("error");
    expect(frameTo({ sessionId: 44, data: "x" })).toEqual([]);
    expect(screencast().filter(([method]) => method === "Page.stopScreencast")).toHaveLength(1);
  });
});

describe("CDP relay downloads", () => {
  it("applies the server's download directory and reports downloads on the root session", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, (directory) => directories.push(directory)),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "goat-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await settle();
    expect(directories).toEqual(["/srv/artifacts"]);
    expect(send).toHaveBeenCalledWith(
      "Browser.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      undefined,
    );
    written.length = 0;
    relay.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
    ]);
  });
});
