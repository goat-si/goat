import { ThreadId, type PreviewSessionSnapshot } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { DesktopBrowserChannel, DesktopTabKey } from "./DesktopBrowserChannel.ts";
import type { PreviewManager } from "./Manager.ts";

export const desktopReattachment = (input: {
  readonly channel: DesktopBrowserChannel["Service"];
  readonly manager: PreviewManager["Service"];
  readonly hasTab: (key: DesktopTabKey) => boolean;
  readonly drop: (key: DesktopTabKey) => boolean;
  readonly ensure: (snapshot: PreviewSessionSnapshot) => Promise<unknown>;
}) => {
  const reconnect = Effect.fn("DesktopReattachment.reconnect")(function* (key: DesktopTabKey) {
    if (input.hasTab(key)) return;
    const { sessions } = yield* input.manager.list({ threadId: ThreadId.make(key.threadId) });
    const snapshot = sessions.find(
      (session) => session.tabId === key.tabId && session.runtime === "server",
    );
    if (snapshot) yield* Effect.promise(() => input.ensure(snapshot).catch(() => undefined));
  });
  return {
    attached: reconnect,
    detached: Effect.fn("DesktopReattachment.detached")(function* (key: DesktopTabKey) {
      if (input.drop(key) && (yield* input.channel.isAttached(key))) yield* reconnect(key);
    }),
  };
};
