import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import { EnvironmentRpcUnavailableError } from "@goat/client-runtime/rpc";
import type { ThreadHistoryMeta } from "@goat/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ toast: vi.fn(), results: [] as Array<unknown> }));
const NOT_SENT = "Test computer reconnected before this ran, so it was not sent. Try again.";
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadEnvironment: {
      ...actual.threadEnvironment,
      loadEarlierHistory: {
        label: "load earlier",
        run: async () => state.results.shift(),
      } as never,
    },
  };
});

import { useThreadHistoryControls } from "./useThreadHistoryControls";

const THREAD: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
};
const HISTORY = {
  hasMoreHistory: true,
  loading: false,
  error: null,
} as unknown as ThreadHistoryMeta;

function LoadEarlier() {
  const controls = useThreadHistoryControls(THREAD, HISTORY);
  return <button onClick={() => controls?.onLoadEarlier()}>Load earlier</button>;
}

const NOT_RUN_TOAST = {
  type: "error",
  title: "Could not load earlier messages",
  description: NOT_SENT,
};
const notRun = () =>
  AsyncResult.failure(
    Cause.fail(new EnvironmentRpcUnavailableError({ environmentId: "env", message: NOT_SENT })),
  );

// Every case ends with a press that could not run. Its toast settles the first press too, so the
// toast's calls show what the first press reported.
it.each([
  { name: "a load that could not run shows why", first: notRun(), toasts: 2 },
  {
    name: "a load that ran and failed leaves the error to the history state",
    first: AsyncResult.success({ _tag: "error", message: "History is unavailable." }),
    toasts: 1,
  },
])("$name", async ({ first, toasts }) => {
  state.toast.mockReset();
  state.results = [first, notRun()];
  await using screen = await render(<LoadEarlier />);
  const button = screen.getByRole("button", { name: "Load earlier" });
  await userEvent.click(button);
  await userEvent.click(button);
  await vi.waitFor(() => expect(state.results).toEqual([]));
  await vi.waitFor(() => expect(state.toast).toHaveBeenLastCalledWith(NOT_RUN_TOAST));
  expect(state.toast.mock.calls).toEqual(Array.from({ length: toasts }, () => [NOT_RUN_TOAST]));
});
