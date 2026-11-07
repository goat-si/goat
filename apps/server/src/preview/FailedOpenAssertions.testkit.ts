import { expect } from "vite-plus/test";
import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Manager from "./Manager.ts";

export const assertTimedOutOpenClosed = Effect.fn("test.assertTimedOutOpenClosed")(function* (
  threadId: ThreadId,
  originalTabId: string,
  error: unknown,
) {
  const manager = yield* Manager.PreviewManager;
  expect(error).toMatchObject({ _tag: "PreviewAutomationTimeoutError", timeoutMs: 15_000 });
  expect(error).toHaveProperty("message", "Preview automation open timed out after 15000ms.");
  const { sessions } = yield* manager.list({ threadId });
  expect(sessions.map((session) => session.tabId)).toEqual([originalTabId]);
});
