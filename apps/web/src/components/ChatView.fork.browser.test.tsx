import {
  CommandId,
  OrchestrationV2ThreadForkError,
  type OrchestrationV2ThreadForkInput,
} from "@goat/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The route loads ChatView lazily, and its first transform takes several seconds; importing it
// here keeps that out of the test's timeout.
import "~/components/ChatView";
import {
  installFakeEnvironment,
  type FakeDriver,
  type FakeRpcHandlers,
} from "../../test/fakeEnvironment";
import {
  FORK,
  answerForks,
  composerEditor as editor,
  dispatchedTypes,
  forkRequests,
  forkSource,
  openThread,
  withProposedPlan,
} from "../../test/forkFixtures";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const pick = forkSource("pick");
const planned = withProposedPlan(forkSource("planned"));
const dirty = forkSource("dirty");
const response = forkSource("response");
const THREADS = [pick.thread, planned, dirty.thread, response.thread];

const install = (rpc: FakeRpcHandlers = {}) =>
  installFakeEnvironment(THREADS, {
    capabilities: { threadForkWorkspace: true },
    rpc: { ...answerForks, ...rpc },
  });

it("picking /fork keeps the rest of the draft and forks into the chosen new worktree", async () => {
  using _environment = install();
  await using _app = await openThread(pick.thread);
  await userEvent.click(editor());
  await userEvent.type(editor(), "keep this /fo");
  await userEvent.click(page.getByText("/fork", { exact: true }));

  await expect.element(editor()).toHaveTextContent("keep this");
  await expect.element(editor()).not.toHaveTextContent("/fo");
  await expect
    .element(page.getByRole("menuitem", { name: "Fork thread", exact: true }))
    .toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Fork thread in new worktree" }));

  await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
  expect(forkRequests()[0]).toMatchObject({
    sourceThreadId: pick.thread.id,
    sourcePoint: { type: "latest_stable" },
    title: "Thread pick fork",
    workspace: { type: "worktree" },
  });
  expect(dispatchedTypes()).toEqual([]);
});

it("a typed /fork with a proposed plan waiting forks instead of answering the plan", async () => {
  using _environment = install();
  await using _app = await openThread(planned);
  await userEvent.click(editor());
  await userEvent.type(editor(), "/fork");
  // Close the command list so Enter submits the draft instead of picking the item.
  await userEvent.keyboard("{Escape}{Enter}");

  await userEvent.click(page.getByRole("menuitem", { name: "Fork thread", exact: true }));
  await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
  expect(forkRequests()[0]).toMatchObject({
    sourceThreadId: planned.id,
    workspace: { type: "current" },
  });
  expect(dispatchedTypes()).toEqual([]);
  await expect.element(editor()).not.toHaveTextContent("/fork");
});

it("offers to fork without uncommitted changes when they cannot be carried", async () => {
  using _environment = install({
    [FORK]: (input: OrchestrationV2ThreadForkInput) =>
      input.workspace.type === "worktree" && input.workspace.includeUncommitted !== false
        ? Effect.fail(
            new OrchestrationV2ThreadForkError({
              commandId: CommandId.make(input.commandId),
              sourceThreadId: input.sourceThreadId,
              reason: "uncommitted_unsupported",
              message: "A submodule change cannot be carried into a worktree.",
            }),
          )
        : answerForks[FORK](input),
  });
  await using _app = await openThread(dirty.thread);
  await userEvent.click(editor());
  await userEvent.type(editor(), "/fork");
  await userEvent.keyboard("{Escape}{Enter}");
  await userEvent.click(page.getByRole("menuitem", { name: "Fork thread in new worktree" }));

  await expect
    .element(page.getByText("A submodule change cannot be carried into a worktree."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Fork without uncommitted changes" }));
  await vi.waitFor(() => expect(forkRequests()).toHaveLength(2));
  expect(forkRequests()[1]).toMatchObject({
    workspace: { type: "worktree", includeUncommitted: false },
  });
  expect(forkRequests()[1]?.commandId).not.toBe(forkRequests()[0]?.commandId);
});

it("a response's fork button offers both workspaces and forks that response's run", async () => {
  using _environment = install();
  await using _app = await openThread(response.thread);
  await userEvent.click(page.getByRole("button", { name: "Fork from this response" }));

  await expect
    .element(page.getByRole("menuitem", { name: "Fork in this workspace" }))
    .toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Fork in a new worktree" }));
  await vi.waitFor(() => expect(forkRequests()).toHaveLength(1));
  expect(forkRequests()[0]).toMatchObject({
    sourceThreadId: response.thread.id,
    sourcePoint: { type: "run", runId: response.run.id },
    workspace: { type: "worktree" },
  });
  expect(dispatchedTypes()).toEqual([]);
});
