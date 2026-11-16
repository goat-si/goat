import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import { EnvironmentRpcUnavailableError } from "@goat/client-runtime/rpc";
import type { ThreadHistoryMeta } from "@goat/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ toast: vi.fn() }));
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
        run: async () =>
          AsyncResult.failure(
            Cause.fail(
              new EnvironmentRpcUnavailableError({ environmentId: "env", message: NOT_SENT }),
            ),
          ),
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

it("shows why loading earlier messages failed", async () => {
  await using screen = await render(<LoadEarlier />);
  await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not load earlier messages",
      description: NOT_SENT,
    }),
  );
});
