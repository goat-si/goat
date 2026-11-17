import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { loadEarlierHistory: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.load }));

import type { ThreadFeedHistoryControls } from "./ThreadFeed";
import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
} from "./threadMessageJump";
import { useThreadHistoryControls } from "./useThreadHistoryControls";
import { useThreadMessageJumpLoading } from "./useThreadMessageJumpLoading";

type Result = AsyncResult.AsyncResult<unknown, unknown>;
const thread = { environmentId: EnvironmentId.make("studio"), id: ThreadId.make("thread-1") };
const threadKey = "studio:thread-1";
const message = MessageId.make("message-1");
const offline = (): Result =>
  AsyncResult.failure(Cause.fail(new Error("Studio is not connected.")));

/** The thread screen's Load earlier control and its message jump, as one screen holds them. */
async function mountThread(historyError: string | null = null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.load.mockReset();
  let controls: ThreadFeedHistoryControls | undefined;
  function Probe(props: { readonly thread: typeof thread; readonly threadKey: string }) {
    controls = useThreadHistoryControls(props.thread, {
      historyCursor: "cursor-1",
      hasMoreHistory: true,
      loading: false,
      error: historyError,
      expanded: false,
      latestLocalTurnOrdinal: null,
    });
    useThreadMessageJumpLoading({
      threadKey: props.threadKey,
      feed: [],
      ready: true,
      history: controls,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const draw = (shown: typeof thread, key: string) =>
    act(async () => root.render(<Probe thread={shown} threadKey={key} />));
  await draw(thread, threadKey);
  return {
    /** The same thread screen now shows another thread, as the detail column does. */
    draw,
    get controls() {
      if (!controls) throw new Error("no controls");
      return controls;
    },
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("a jump picked while a Load earlier failure shows still loads down to its message, and its own failure ends it (#3556)", async () => {
  await using screen = await mountThread();
  mocks.load.mockResolvedValueOnce(offline());
  await act(async () => screen.controls.onLoadEarlier());
  expect(screen.controls.error).toBe("Studio is not connected.");
  const jump = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(jump.promise);
  await act(async () => requestThreadMessageJump(threadKey, message));
  expect(mocks.load).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, throughEntryId: message },
  });
  expect(pendingThreadMessageJump(threadKey)).toBe(message);
  await act(async () => jump.resolve(offline()));
  expect(pendingThreadMessageJump(threadKey)).toBeNull();
  expect(screen.controls.error).toBe("Studio is not connected.");
});

it("a jump picked while an older history error shows still loads down to its message (#3556)", async () => {
  await using _screen = await mountThread("Could not reach the history.");
  mocks.load.mockReturnValueOnce(Promise.withResolvers<Result>().promise);
  await act(async () => requestThreadMessageJump(threadKey, message));
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, throughEntryId: message },
  });
  await act(async () => finishThreadMessageJump(threadKey));
});

it("a jump into another thread doesn't wait for the previous thread's jump that is still loading (#3556)", async () => {
  await using screen = await mountThread();
  mocks.load.mockReturnValueOnce(Promise.withResolvers<Result>().promise);
  await act(async () => requestThreadMessageJump(threadKey, message));
  expect(mocks.load).toHaveBeenCalledOnce();
  const other = { environmentId: thread.environmentId, id: ThreadId.make("thread-2") };
  await screen.draw(other, "studio:thread-2");
  mocks.load.mockReturnValueOnce(Promise.withResolvers<Result>().promise);
  await act(async () => requestThreadMessageJump("studio:thread-2", message));
  expect(mocks.load).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: { threadId: other.id, throughEntryId: message },
  });
  await act(async () => finishThreadMessageJump("studio:thread-2"));
});

it("guard: a load with nothing to load ends the jump instead of trying again (#3556)", async () => {
  await using _screen = await mountThread();
  mocks.load.mockResolvedValue(AsyncResult.success({ _tag: "noop" }));
  await act(async () => requestThreadMessageJump(threadKey, message));
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(pendingThreadMessageJump(threadKey)).toBeNull();
});

it("an earlier jump's failed load doesn't end a newer jump in the same thread, which then loads down to its own message (#3556)", async () => {
  await using _screen = await mountThread();
  const first = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(first.promise);
  await act(async () => requestThreadMessageJump(threadKey, message));
  const newer = MessageId.make("message-2");
  await act(async () => requestThreadMessageJump(threadKey, newer));
  expect(mocks.load).toHaveBeenCalledOnce();
  mocks.load.mockReturnValueOnce(Promise.withResolvers<Result>().promise);
  await act(async () => first.resolve(offline()));
  expect(pendingThreadMessageJump(threadKey)).toBe(newer);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(mocks.load).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, throughEntryId: newer },
  });
  await act(async () => finishThreadMessageJump(threadKey));
});

it("picking the same message again while its first jump is loading makes a second attempt when the first fails (#3556)", async () => {
  await using _screen = await mountThread();
  const first = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(first.promise);
  await act(async () => requestThreadMessageJump(threadKey, message));
  await act(async () => requestThreadMessageJump(threadKey, message));
  expect(mocks.load).toHaveBeenCalledOnce();
  const second = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(second.promise);
  await act(async () => first.resolve(offline()));
  expect(pendingThreadMessageJump(threadKey)).toBe(message);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve(offline()));
  expect(pendingThreadMessageJump(threadKey)).toBeNull();
});
