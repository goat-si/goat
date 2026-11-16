import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  announce: vi.fn(),
  platform: { OS: "android" },
}));
vi.mock("react-native", () => ({
  Platform: mocks.platform,
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { loadEarlierHistory: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.load }));

import type { ThreadFeedHistoryControls } from "./ThreadFeed";
import { useThreadHistoryControls } from "./useThreadHistoryControls";

type Result = AsyncResult.AsyncResult<unknown, unknown>;
const studio = { environmentId: EnvironmentId.make("studio"), id: ThreadId.make("thread-1") };
const history = {
  historyCursor: "cursor-1",
  hasMoreHistory: true,
  loading: false,
  error: null as string | null,
  expanded: false,
  latestLocalTurnOrdinal: null,
};
const failed = (cause: Cause.Cause<unknown>): Result => AsyncResult.failure(cause);
const offline = () => failed(Cause.fail(new Error("Studio is not connected.")));

async function mountControls(initial: { thread?: typeof studio; error?: string | null } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.load.mockReset();
  mocks.announce.mockReset();
  mocks.platform.OS = "android";
  let controls: ThreadFeedHistoryControls | undefined;
  function Probe(props: { readonly thread: typeof studio; readonly error: string | null }) {
    controls = useThreadHistoryControls(props.thread, { ...history, error: props.error });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const draw = (thread = initial.thread ?? studio, error = initial.error ?? null) =>
    act(async () => root.render(<Probe thread={thread} error={error} />));
  await draw();
  return {
    draw,
    get controls() {
      if (!controls) throw new Error("no controls");
      return controls;
    },
    press: () => act(async () => controls?.onLoadEarlier()),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("shows why Load earlier failed when the command fails before loading anything (#3556)", async () => {
  await using view = await mountControls();
  mocks.load.mockResolvedValueOnce(offline());
  await view.press();
  expect(view.controls.error).toBe("Studio is not connected.");
});

it("shows the newer command failure over an older history error (#3556)", async () => {
  await using view = await mountControls({ error: "Could not reach the history." });
  mocks.load.mockResolvedValueOnce(offline());
  await view.press();
  expect(view.controls.error).toBe("Studio is not connected.");
});

it("a failed jump to a message shows its failure too (#3556)", async () => {
  await using view = await mountControls();
  mocks.load.mockResolvedValueOnce(offline());
  await act(async () => view.controls.onLoadThrough("entry-1"));
  expect(view.controls.error).toBe("Studio is not connected.");
});

it("a crash in the command shows the fixed text, not its message (#3556)", async () => {
  await using view = await mountControls();
  mocks.load.mockResolvedValueOnce(failed(Cause.die(new Error("boom"))));
  await view.press();
  expect(view.controls.error).toBe("Could not load earlier activity.");
});

it("announces the failure to VoiceOver on iOS (#3556)", async () => {
  await using view = await mountControls();
  mocks.platform.OS = "ios";
  mocks.load.mockResolvedValueOnce(offline());
  await view.press();
  expect(mocks.announce).toHaveBeenCalledExactlyOnceWith("Studio is not connected.");
});

it("doesn't announce on Android, where the error line is a live region (#3556)", async () => {
  await using view = await mountControls();
  mocks.load.mockResolvedValueOnce(offline());
  await view.press();
  expect(view.controls.error).toBe("Studio is not connected.");
  expect(mocks.announce).not.toHaveBeenCalled();
});

it("guard: pressing again clears the failure while the new load runs (#3556)", async () => {
  await using view = await mountControls();
  const retry = Promise.withResolvers<Result>();
  mocks.load.mockResolvedValueOnce(offline()).mockReturnValueOnce(retry.promise);
  await view.press();
  await view.press();
  expect(view.controls.error).toBeNull();
  await act(async () => retry.resolve(AsyncResult.success({ _tag: "loaded" })));
  expect(view.controls.error).toBeNull();
});

it("guard: an older press that fails after a newer one succeeded shows nothing (#3556)", async () => {
  await using view = await mountControls();
  const older = Promise.withResolvers<Result>();
  const newer = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await view.press();
  await view.press();
  await act(async () => newer.resolve(AsyncResult.success({ _tag: "loaded" })));
  await act(async () => older.resolve(offline()));
  expect(view.controls.error).toBeNull();
});

it("guard: an interrupted load shows nothing (#3556)", async () => {
  await using view = await mountControls();
  mocks.load.mockResolvedValueOnce(failed(Cause.interrupt()));
  await view.press();
  expect(view.controls.error).toBeNull();
});

it("guard: a failure on one thread does not show on another (#3556)", async () => {
  await using view = await mountControls();
  mocks.load.mockResolvedValueOnce(offline());
  await view.press();
  await view.draw({ environmentId: studio.environmentId, id: ThreadId.make("thread-2") });
  expect(view.controls.error).toBeNull();
});

it("a pending load that fails after the person switched threads shows nothing and announces nothing (#3556)", async () => {
  await using view = await mountControls();
  mocks.platform.OS = "ios";
  const pending = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(pending.promise);
  await view.press();
  await view.draw({ environmentId: studio.environmentId, id: ThreadId.make("thread-2") });
  await act(async () => pending.resolve(offline()));
  expect(view.controls.error).toBeNull();
  expect(mocks.announce).not.toHaveBeenCalled();
});

it("a pending load that fails after the thread screen closed announces nothing (#3556)", async () => {
  const view = await mountControls();
  mocks.platform.OS = "ios";
  const pending = Promise.withResolvers<Result>();
  mocks.load.mockReturnValueOnce(pending.promise);
  await view.press();
  await view[Symbol.asyncDispose]();
  await act(async () => pending.resolve(offline()));
  expect(mocks.announce).not.toHaveBeenCalled();
});

it("a failure for the thread the person came back to still shows, after a press on another thread (#3556)", async () => {
  await using view = await mountControls();
  const first = Promise.withResolvers<Result>();
  mocks.load
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(Promise.withResolvers<Result>().promise);
  await view.press();
  await view.draw({ environmentId: studio.environmentId, id: ThreadId.make("thread-2") });
  await view.press();
  await view.draw(studio);
  await act(async () => first.resolve(offline()));
  expect(view.controls.error).toBe("Studio is not connected.");
});
