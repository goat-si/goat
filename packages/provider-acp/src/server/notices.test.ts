import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";
import { parseSessionUpdateEvent } from "./runtimeModel.ts";

describe("ACP notices", () => {
  it("bounds notice content and discards whitespace-only titles", () => {
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "notice",
        severity: ` ${"w".repeat(80)} `,
        title: ` ${"t".repeat(1_100)} `,
        description: ` ${"d".repeat(4_200)} `,
      },
    } satisfies EffectAcpSchema.SessionNotification;
    expect(parseSessionUpdateEvent(notification).events).toEqual([
      {
        _tag: "NoticeReceived",
        severity: "w".repeat(64),
        title: "t".repeat(1_024),
        description: "d".repeat(4_096),
        rawPayload: notification,
      },
    ]);
    expect(
      parseSessionUpdateEvent({
        ...notification,
        update: { ...notification.update, title: " \n\t " },
      }).events,
    ).toEqual([]);
    expect(
      parseSessionUpdateEvent({
        ...notification,
        update: {
          ...notification.update,
          title: " Announcement ",
          severity: " ",
          description: null,
        },
      }).events,
    ).toMatchObject([{ _tag: "NoticeReceived", severity: "info", title: "Announcement" }]);
  });
});
