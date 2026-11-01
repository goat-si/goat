import { RunId, ThreadId, TurnItemId } from "@goat/contracts";
import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileChangeRowLabel } from "./fileChangeInlineDiff.logic";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function fileChange(overrides: Partial<FileChangeItem>): FileChangeItem {
  return {
    id: TurnItemId.make("item-1"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: "2026-10-20T00:00:00.000Z",
    completedAt: "2026-10-20T00:00:01.000Z",
    updatedAt: "2026-10-20T00:00:01.000Z",
    type: "file_change",
    fileName: "/home/jun/.goat/worktrees/goat/goat-f6e894b6/apps/web/src/components/ChatView.tsx",
    ...overrides,
  } as FileChangeItem;
}

describe("fileChangeRowLabel", () => {
  it("names the file without the worktree folder", () => {
    expect(fileChangeRowLabel(fileChange({}))).toBe("Edited ChatView.tsx");
  });

  it("uses the operation of a single-kind change and counts the other files", () => {
    expect(
      fileChangeRowLabel(
        fileChange({
          changes: [
            { operation: "add", path: "/repo/coggs-resume.mjs" },
            { operation: "add", path: "/repo/notes.md" },
          ],
        }),
      ),
    ).toBe("Created coggs-resume.mjs +1 more");
  });
});
