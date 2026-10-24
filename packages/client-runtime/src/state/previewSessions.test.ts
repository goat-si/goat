import { type PreviewSession, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orderPreviewSessions, previewSessionDetail } from "./previewSessions.ts";

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
