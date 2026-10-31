import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { awaitHistoryPrefix } from "../cua/ComputerUseHistoryBackground.ts";
import { browserHistoryPrefix } from "./BrowserHistoryRecordAction.ts";

export const assertDialogHistory = Effect.fn("test.assertDialogHistory")(function* (
  threadId: string,
) {
  yield* awaitHistoryPrefix(browserHistoryPrefix(threadId));
  const history = yield* makeComputerUseHistory;
  const entries = yield* history.listForThread(threadId);
  expect(
    entries.some((entry) => entry.method === "evaluate" && entry.tabHost === "localhost"),
  ).toBe(true);
  expect(entries.some((entry) => entry.method === "dialog" && entry.tabHost === "localhost")).toBe(
    true,
  );
  const dialog = entries.find((entry) => entry.method === "dialog");
  expect(dialog?.typedLength).toBe(7);
  expect(dialog?.typedText).toBeNull();
});
