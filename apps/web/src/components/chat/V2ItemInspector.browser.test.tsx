import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { V2ItemInspector } from "./V2ItemInspector";

vi.mock("../../state/queries", () => ({
  useTurnItemDetail: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("../../state/v2ItemSupport", () => ({ useV2ItemSupport: () => ({}) }));
vi.mock("../ChatMarkdown", () => ({ default: () => null, ChatMarkdownAssetImage: () => null }));

const runId = RunId.make("run-edit");
const threadId = ThreadId.make("thread-edit");
const timestamp = DateTime.makeUnsafe("2026-06-20T00:00:03.000Z");
const item: Extract<OrchestrationV2TurnItem, { type: "file_change" }> = {
  id: TurnItemId.make("edit"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: timestamp,
  completedAt: timestamp,
  updatedAt: timestamp,
  type: "file_change",
  fileName: "/workspace/src/a.ts",
  additions: 101,
  deletions: 2,
};

let root: Root;
let container: HTMLDivElement;
const onOpenTurnDiff = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderItem(changes: typeof item.changes, hideFileChangeSummary = false) {
  await act(() =>
    root.render(
      <V2ItemInspector
        projectedItem={{
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item: { ...item, changes },
        }}
        environmentId={EnvironmentId.make("environment-edit")}
        workspaceRoot="/workspace"
        onOpenThread={vi.fn()}
        onOpenTurnDiff={onOpenTurnDiff}
        hideFileChangeSummary={hideFileChangeSummary}
      />,
    ),
  );
}

it("labels multi-file counts as a total and opens the complete diff", async () => {
  await renderItem([
    { operation: "update", path: "/workspace/src/a.ts" },
    { operation: "update", path: "/workspace/src/b.ts" },
  ]);
  expect(container.textContent).toContain("2 files total");
  expect(container.textContent).toContain("+101 -2");
  expect(container.textContent).toContain("update workspace/src/a.ts");
  expect(container.textContent).toContain("update workspace/src/b.ts");
  await act(() => container.querySelector("button")!.click());
  expect(onOpenTurnDiff).toHaveBeenCalledWith(runId, undefined);
});

it.each([undefined, [], [{ operation: "update", path: "/workspace/src/a.ts" }]])(
  "keeps the file name and filtered diff for single-file edits with changes %j",
  async (changes) => {
    await renderItem(changes);
    expect(container.textContent).not.toContain("files total");
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("+101 -2");
    await act(() => container.querySelector("button")!.click());
    expect(onOpenTurnDiff).toHaveBeenCalledWith(runId, "/workspace/src/a.ts");
  },
);

it("leaves the summary to the row it expands from, without repeating totals", async () => {
  await renderItem(
    [
      { operation: "update", path: "/workspace/src/a.ts" },
      { operation: "update", path: "/workspace/src/b.ts" },
    ],
    true,
  );
  expect(container.textContent).not.toContain("files total");
  expect(container.textContent).not.toContain("+101");
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("update workspace/src/a.ts");
  expect(container.textContent).toContain("update workspace/src/b.ts");
});

it("names the file when a row's edit has nothing else to show", async () => {
  await renderItem(undefined, true);
  expect(container.textContent).toBe("workspace/src/a.ts");
  expect(container.querySelector("button")).toBeNull();
});
