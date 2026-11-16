import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import { EnvironmentNotRegisteredError } from "@goat/client-runtime/connection";
import type { ThreadHistoryMeta } from "@goat/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";

const mocks = vi.hoisted(() => ({ results: [] as Array<unknown> }));
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadEnvironment: {
      ...actual.threadEnvironment,
      loadEarlierHistory: {
        label: "load earlier",
        run: async () => mocks.results.shift(),
      } as never,
    },
  };
});

import { useThreadHistoryControls } from "./useThreadHistoryControls";

/** Answers the next presses of Load earlier, in order. */
function setup(...results: Array<unknown>) {
  mocks.results = results;
}

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

// The one command failure Load earlier can get on dev: its computer was removed.
const notRun = (environmentId: string) =>
  AsyncResult.failure(
    Cause.fail(
      new EnvironmentNotRegisteredError({ environmentId: EnvironmentId.make(environmentId) }),
    ),
  );
const RAN_AND_FAILED = AsyncResult.success({ _tag: "error", message: "History is unavailable." });

it("shows why a load that could not run failed", async () => {
  setup(notRun("removed-computer"));
  await using screen = await render(
    <ToastProvider timeout={0}>
      <LoadEarlier />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  await expect.element(page.getByText("Could not load earlier messages")).toBeVisible();
  await expect.element(page.getByText(/removed-computer/)).toBeVisible();
});

// The timeline shows a failed load from history.error, so a toast would say it twice.
it("leaves a load that ran and failed to the history state", async () => {
  setup(RAN_AND_FAILED, notRun("second-press"));
  await using screen = await render(
    <ToastProvider timeout={0}>
      <LoadEarlier />
    </ToastProvider>,
  );
  const button = screen.getByRole("button", { name: "Load earlier" });
  await userEvent.click(button);
  // The second press settles after the first, so its toast marks the first one as settled.
  await userEvent.click(button);
  await expect.element(page.getByText(/second-press/)).toBeVisible();
  expect(page.getByText("Could not load earlier messages").elements()).toHaveLength(1);
  expect(page.getByText("History is unavailable.").elements()).toHaveLength(0);
});
