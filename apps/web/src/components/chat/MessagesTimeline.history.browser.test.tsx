import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/render";
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

it("keeps a tool row open when a text selection completes, while click and keyboard toggle it", async () => {
  const item = {
    id: "browser-selection",
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
  await vi.waitFor(() => expect(screen.button(/^Received 1 update/)).toBeDefined());
  await click(screen.button(/^Received 1 update/));
  await vi.waitFor(() => expect(screen.text()).toContain("Clicked in the preview browser"));
  const row = screen.button(/preview/i);
  await click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const label = [...row.querySelectorAll("span")].find((span) =>
    span.textContent?.includes("Clicked in the preview browser"),
  );
  expect(label).toBeDefined();
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(label!);
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();
  expect(selectedText).not.toBe("");
  await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(selection.toString()).toBe(selectedText);
  selection.removeAllRanges();
  await click(row);
  expect(row.getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(row.getAttribute("aria-expanded")).toBe("true");
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
  );
  expect(row.getAttribute("aria-expanded")).toBe("false");
});
