import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The route loads ChatView lazily, and its first transform takes several seconds; importing it
// here keeps that out of the test's timeout.
import "~/components/ChatView";
import { installFakeEnvironment, type FakeDriver } from "../../test/fakeEnvironment";
import {
  answerForks,
  composerEditor as editor,
  dispatched,
  dispatchedTypes,
  forkRequests,
  forkSource,
  openThread,
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

// A server from before orchestration.forkThread: no threadForkWorkspace capability.
const typed = forkSource("typed");
const response = forkSource("response");
const install = () => installFakeEnvironment([typed.thread, response.thread], { rpc: answerForks });

it("a typed /fork forks at once in the same checkout through thread.fork", async () => {
  using _environment = install();
  await using _app = await openThread(typed.thread);
  await userEvent.click(editor());
  await userEvent.type(editor(), "/fork");
  await userEvent.keyboard("{Escape}{Enter}");

  await vi.waitFor(() => expect(dispatchedTypes()).toEqual(["thread.fork"]));
  expect(dispatched()[0]).toMatchObject({
    sourceThreadId: typed.thread.id,
    sourcePoint: { type: "latest_stable" },
  });
  expect(forkRequests()).toEqual([]);
  expect(page.getByRole("menu").query()).toBeNull();
});

it("a response's fork button forks its run in the same checkout as before", async () => {
  using _environment = install();
  await using _app = await openThread(response.thread);
  await userEvent.click(page.getByRole("button", { name: "Fork from this response" }));

  await vi.waitFor(() => expect(dispatchedTypes()).toEqual(["thread.fork"]));
  expect(dispatched()[0]).toMatchObject({
    sourceThreadId: response.thread.id,
    sourcePoint: { type: "run", runId: response.run.id },
  });
  expect(forkRequests()).toEqual([]);
  expect(page.getByRole("menu").query()).toBeNull();
});
