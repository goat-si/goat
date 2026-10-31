import { act } from "react";
import { expect, it, vi } from "vite-plus/test";
const permission = vi.hoisted(() => ({ allowed: true, request: vi.fn() }));
import { EnvironmentId, OrchestrationV2TurnItemJson, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: () => permission.allowed,
}));
vi.mock("@goat/client-runtime/state/computer-use-history", () => ({
  createComputerUseHistoryCommand: () => ({ permissionAtom: () => null }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => permission.request }));
import { createNativeMemoryHarness, renderNative } from "../../testing/memoryNativeHarness";
import { Pressable, Text } from "react-native";
import { useThreadHistoryMenu } from "./useThreadHistoryMenu";
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
import { ThreadComputerUseHistoryView } from "./ThreadComputerUseHistoryView";
import {
  ThreadComputerUseHistory,
  ThreadComputerUseHistoryForItem,
} from "./ThreadComputerUseHistory";

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

it("mounts input history for a browser-only work entry", async () => {
  const item = decodeItem({
    id: "browser-action",
    type: "dynamic_tool",
    threadId: "thread:a",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    toolName: "goat.preview_click",
    input: {},
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-29T00:00:00.000Z",
  });
  const harness = createNativeMemoryHarness();
  const view = renderNative(
    harness,
    <ThreadComputerUseHistoryForItem
      item={item}
      environmentId={EnvironmentId.make("environment:a")}
      threadId={ThreadId.make("thread:a")}
    />,
  );
  try {
    await view.render();
    expect(view.container.textContent).toContain("Show input history");
  } finally {
    await view.unmount();
    harness.dispose();
  }
});

it("loads and pages newest-first input history with refusal details", async () => {
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
  const load = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [
        { ...base, id: 2, method: "click", verdict: "refused", refusalCode: "target_busy" },
      ],
      nextCursor: { recordedAt: 0, id: 2 },
    })
    .mockResolvedValueOnce({
      entries: [
        { ...base, id: 1, method: "type_text", verdict: "sent", refusalCode: null, typedLength: 6 },
      ],
      nextCursor: null,
    });
  const harness = createNativeMemoryHarness();
  const view = renderNative(harness, <ThreadComputerUseHistoryView canRead load={load} />);
  try {
    await view.render();
    expect(load).not.toHaveBeenCalled();
    await view.click("Show input history");
    expect(view.container.textContent).toContain("target_busy");
    await view.click("Load more");
    expect(load).toHaveBeenLastCalledWith({ recordedAt: 0, id: 2 });
    expect(view.container.textContent).toContain("6 characters");
    expect(view.container.textContent?.indexOf("click")).toBeLessThan(
      view.container.textContent?.indexOf("type_text") ?? -1,
    );
  } finally {
    await view.unmount();
    harness.dispose();
  }
});

function HistoryMenuFixture() {
  const history = useThreadHistoryMenu(
    EnvironmentId.make("environment:a"),
    ThreadId.make("thread:empty"),
  );
  return (
    <>
      {history.actions.map((action) => (
        <Pressable
          key={action.id}
          accessibilityLabel={action.title}
          onPress={() => history.select(action.id)}
        >
          <Text>{action.title}</Text>
        </Pressable>
      ))}
      {history.dialog}
    </>
  );
}

it("opens empty thread history from the menu only with read permission", async () => {
  permission.allowed = true;
  permission.request.mockResolvedValue({
    _tag: "Success",
    value: { entries: [], nextCursor: null },
  });
  const harness = createNativeMemoryHarness();
  const view = renderNative(harness, <HistoryMenuFixture />);
  try {
    await view.render();
    await view.click("Computer use history");
    await view.click("Show input history");
    expect(view.container.textContent).toContain("No input history.");
  } finally {
    await view.unmount();
    harness.dispose();
  }
  permission.allowed = false;
  const other = createNativeMemoryHarness();
  const denied = renderNative(other, <HistoryMenuFixture />);
  try {
    await denied.render();
    expect(denied.container.textContent).not.toContain("Computer use history");
  } finally {
    await denied.unmount();
    other.dispose();
    permission.allowed = true;
  }
});

it.each([false, true])("isolates history after switching threads, delayed=%s", async (delayed) => {
  const env = EnvironmentId.make("environment:a");
  const a = ThreadId.make("thread:a");
  const b = ThreadId.make("thread:b");
  const reply = Promise.withResolvers<unknown>();
  const row = {
    id: 1,
    threadId: a,
    recordedAt: 0,
    targetKind: "app",
    appId: "fixture.app",
    appName: "Fixture",
    tabHost: null,
    method: "thread_A_only_action",
    targetLabel: null,
    verdict: "sent",
    refusalCode: null,
    typedLength: null,
    typedText: null,
  };
  permission.allowed = true;
  permission.request
    .mockReset()
    .mockImplementationOnce(() => reply.promise)
    .mockResolvedValue({ _tag: "Success", value: { entries: [], nextCursor: null } });
  const harness = createNativeMemoryHarness();
  const view = renderNative(harness, <ThreadComputerUseHistory environmentId={env} threadId={a} />);
  try {
    await view.render();
    await view.click("Show input history");
    if (!delayed)
      await act(async () =>
        reply.resolve({ _tag: "Success", value: { entries: [row], nextCursor: null } }),
      );
    await view.rerender(<ThreadComputerUseHistory environmentId={env} threadId={b} />);
    if (delayed)
      await act(async () =>
        reply.resolve({ _tag: "Success", value: { entries: [row], nextCursor: null } }),
      );
    expect(view.container.textContent).not.toContain("thread_A_only_action");
    await view.click("Show input history");
    expect(view.container.textContent).toContain("No input history.");
    expect(permission.request.mock.calls[1]?.[0].input.threadId).toBe(b);
  } finally {
    await view.unmount();
    harness.dispose();
  }
});
