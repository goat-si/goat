import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveToolCallDiffTarget,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const EDIT = {
  threadId: ThreadId.make("child"),
  itemId: TurnItemId.make("edit"),
  revision: "live",
};

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    }),
  );

  it("keeps each repository scope distinct and preserves the branch base", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    for (const kind of ["uncommitted", "staged", "unstaged"] as const) {
      store.selectGitScope(THREAD_REF, kind);
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
      ).toEqual({ kind });
    }
    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("regression #1397: keeps an edit's own diff selected whatever checkpoints exist", () => {
    const store = useDiffPanelStore.getState();
    store.selectToolCall(THREAD_REF, EDIT, "src/a.ts");
    store.reconcileTurnSelection(THREAD_REF, [RunId.make("run-1")]);
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(THREAD_REF)]).toEqual({
      kind: "tool-call",
      ...EDIT,
      filePath: "src/a.ts",
      revealRequestId: 1,
    });
    store.selectGitScope(THREAD_REF, "branch");
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(THREAD_REF)]).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("refreshes a tool call opened while it ran once it completes", () => {
    const now = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
    const row = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: EDIT.threadId,
      sourceItemId: EDIT.itemId,
      item: {
        id: EDIT.itemId,
        threadId: EDIT.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "file_change" as const,
        fileName: "a.ts",
      },
    };
    expect(resolveToolCallDiffTarget(EDIT, [row])).toBe(EDIT);
    const completed = { ...row, item: { ...row.item, status: "completed" as const } };
    expect(resolveToolCallDiffTarget(EDIT, [completed])).toEqual({
      ...EDIT,
      revision: DateTime.formatIso(now),
    });
    expect(
      resolveToolCallDiffTarget(EDIT, [{ ...completed, sourceThreadId: ThreadId.make("other") }]),
    ).toBe(EDIT);
  });

  it("migrates the old unstaged name without changing Uncommitted's meaning", async () => {
    const store = useDiffPanelStore.getState();
    store.selectGitScope(THREAD_REF, "unstaged");
    const migrated = await useDiffPanelStore.persist.getOptions().migrate!(
      {
        byThreadKey: useDiffPanelStore.getState().byThreadKey,
        branchBaseRefByThreadKey: {},
      },
      2,
    );
    expect(migrated).toEqual({
      byThreadKey: { [scopedThreadKey(THREAD_REF)]: { kind: "uncommitted" } },
      branchBaseRefByThreadKey: {},
    });
  });
});

import { useDiffPanelSessionStore } from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
});
