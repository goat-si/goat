import { expect, it, vi } from "vite-plus/test";
import { type Entry, CREATED_AT, click, renderTimeline } from "./MessagesTimeline.browserHarness";

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

it("shows input history for a browser-only work entry", async () => {
  const item = {
    id: "browser-action",
    type: "dynamic_tool",
    toolName: "goat.preview_click",
    input: { selector: "button" },
    output: { ok: true },
  };
  await using screen = await renderTimeline([
    work("context-info", { label: "Session started", tone: "info" }),
    work(item.id, {
      runId: null,
      label: item.toolName,
      tone: "tool",
      itemType: item.type,
      toolTitle: item.toolName,
      toolLifecycleStatus: "completed",
      toolData: { input: item.input, output: item.output },
      structuredPayload: v2Item("dynamic_tool", item),
      projectedItem: v2Item("dynamic_tool", item),
    }),
  ]);
  await click(screen.button(/^Received 1 update/));
  await vi.waitFor(() => expect(screen.text()).toContain("Clicked in the preview browser"));
  await click(screen.button(/preview/i));
  expect(screen.text()).toContain("Show input history");
});
