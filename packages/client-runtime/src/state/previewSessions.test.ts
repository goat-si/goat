import { type PreviewSession, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentCursorPlacement,
  orderPreviewSessions,
  previewSessionDetail,
} from "./previewSessions.ts";

const session = (id: string, status: PreviewSession["status"]): PreviewSession =>
  ({
    id,
    kind: "browser",
    status,
    owner: "agent",
    target: { kind: "browser", tabId: id, url: `https://${id}.example/path`, title: id },
  }) as PreviewSession;

describe("preview session stack order", () => {
  it("puts sessions waiting for a person first, live work next with the newest on top, stopped last", () => {
    const order = orderPreviewSessions([
      session("old-acting", "acting"),
      session("stopped", "stopped"),
      session("waiting", "waiting-for-human"),
      session("new-acting", "acting"),
    ]).map((entry) => entry.id);
    expect(order).toEqual(["waiting", "new-acting", "old-acting", "stopped"]);
  });

  it("names a browser session by its host and a desktop one by what it may touch", () => {
    expect(previewSessionDetail(session("docs", "acting"))).toBe("docs.example");
    const desktop = {
      ...session("d", "acting"),
      kind: "desktop",
      target: { kind: "desktop", title: "com.apple.calculator" },
    } as PreviewSession;
    expect(previewSessionDetail(desktop)).toBe("Whole screen");
    const scoped: PreviewSession = {
      ...desktop,
      lease: { threadId: ThreadId.make("t"), expiresAt: "", scope: ["com.apple.calculator"] },
    };
    expect(previewSessionDetail(scoped)).toBe("com.apple.calculator");
  });
});

describe("agent cursor over a desktop picture", () => {
  const cursor = { windowId: 3, point: { fx: 0.5, fy: 0.25 }, phase: "acting" } as const;

  it("places the point on a picture letterboxed left and right, not on the empty bands", () => {
    // A 400x200 box shows a 1:1 frame as 200x200, 100px in from each side.
    expect(
      agentCursorPlacement(cursor, { width: 10, height: 10 }, { width: 400, height: 200 }),
    ).toEqual({ left: 200, top: 50 });
    expect(
      agentCursorPlacement(
        { ...cursor, point: { fx: 0, fy: 1 } },
        { width: 10, height: 10 },
        {
          width: 400,
          height: 200,
        },
      ),
    ).toEqual({ left: 100, top: 200 });
  });

  it("places the point on a picture letterboxed top and bottom", () => {
    // A 200x400 box shows a 2:1 frame as 200x100, 150px down from the top.
    expect(
      agentCursorPlacement(
        { ...cursor, point: { fx: 0.25, fy: 1 } },
        { width: 20, height: 10 },
        { width: 200, height: 400 },
      ),
    ).toEqual({ left: 50, top: 250 });
  });

  it("places nothing before the frame or the box has a size", () => {
    expect(
      agentCursorPlacement(cursor, { width: 0, height: 10 }, { width: 400, height: 200 }),
    ).toBeUndefined();
    expect(
      agentCursorPlacement(cursor, { width: 10, height: 10 }, { width: 0, height: 0 }),
    ).toBeUndefined();
  });
});
