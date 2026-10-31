import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ request: vi.fn(), canRead: true }));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => mocks.canRead,
}));
vi.mock("@goat/client-runtime/state/computer-use-history", () => ({
  createComputerUseHistoryCommand: () => ({ permissionAtom: () => null }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.request }));

import { ComputerUseHistorySection } from "./ComputerUseHistorySection";

it("loads history on demand, pages older results, and clears it when the thread changes", async () => {
  const base = {
    threadId: "thread:a",
    recordedAt: 0,
    targetKind: "app",
    appId: "fixture.app",
    appName: "Fixture",
    tabHost: null,
    targetLabel: null,
    typedText: null,
    typedLength: null,
  } as const;
  mocks.request.mockReset();
  mocks.request.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      entries: [
        { ...base, id: 2, method: "click", verdict: "refused", refusalCode: "target_busy" },
      ],
      nextCursor: { recordedAt: 0, id: 2 },
    },
  });
  mocks.request.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      entries: [{ ...base, id: 1, method: "type_text", verdict: "sent", refusalCode: null }],
      nextCursor: null,
    },
  });
  const environmentId = EnvironmentId.make("environment:a");
  const threadId = ThreadId.make("thread:a");
  await using screen = await render(
    <ComputerUseHistorySection key="a" environmentId={environmentId} threadId={threadId} />,
  );
  expect(mocks.request).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Show input history" }));
  await expect.element(screen.getByText(/target_busy/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByText(/type_text/)).toBeVisible();
  expect(mocks.request.mock.calls[1]?.[0].input.before).toEqual({ recordedAt: 0, id: 2 });
  await screen.rerender(
    <ComputerUseHistorySection
      key="b"
      environmentId={environmentId}
      threadId={ThreadId.make("thread:b")}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Show input history" })).toBeVisible();
  expect(screen.getByText(/target_busy/).elements()).toHaveLength(0);
});

it("offers thread history without work entries only with read permission", async () => {
  const environmentId = EnvironmentId.make("environment:a");
  const threadId = ThreadId.make("thread:empty");
  mocks.canRead = true;
  mocks.request
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { entries: [], nextCursor: null } });
  await using screen = await render(
    <ComputerUseHistorySection
      environmentId={environmentId}
      threadId={threadId}
      hideWithoutPermission
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Show input history" }));
  await expect.element(screen.getByText("No input history.")).toBeVisible();
  mocks.canRead = false;
  await screen.rerender(
    <ComputerUseHistorySection
      key="forbidden"
      environmentId={environmentId}
      threadId={threadId}
      hideWithoutPermission
    />,
  );
  expect(screen.getByRole("button", { name: "Show input history" }).elements()).toHaveLength(0);
});
