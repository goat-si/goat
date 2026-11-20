import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  canOpenSideChat,
  findSideChatThread,
  parseSideChatCommand,
  resolveSideChatOpen,
  sideChatParentStatus,
} from "./sideChat.logic";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { useSideChatStore } from "./sideChatStore";
import { scopedThreadKey } from "@goat/client-runtime/environment";

describe("parseSideChatCommand", () => {
  it("reads the question after /side", () => {
    expect(parseSideChatCommand("/side what does this test cover?")).toEqual({
      prompt: "what does this test cover?",
    });
    expect(parseSideChatCommand("  /SIDE\nfirst line\nsecond line ")).toEqual({
      prompt: "first line\nsecond line",
    });
  });

  it("opens an empty side chat for a bare /side", () => {
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
  });

  it("ignores other commands and prose that mentions /side", () => {
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("please /side this")).toBeNull();
  });
});

describe("findSideChatThread", () => {
  const parentId = ThreadId.make("parent");
  const parent = makeThreadFixture({ id: parentId });
  const parentRef = scopeThreadRef(parent.environmentId, parentId);
  const side = (id: string, createdAt: string, extra: object = {}) => ({
    ...makeThreadFixture({ id: ThreadId.make(id) }),
    sideChatOf: parentId,
    createdAt,
    ...extra,
  });

  it("opens the explicitly selected live side chat even if another is newer", () => {
    const older = side("older-selected", "2026-10-13T01:00:00.000Z");
    const newer = side("newer-selected", "2026-10-13T02:00:00.000Z");
    expect(findSideChatThread([parent, older, newer], parentRef, older.id)?.id).toBe(older.id);
  });

  it("routes a side chat to its owner and selects the requested side chat", () => {
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    const target = side("requested", "2026-10-13T01:00:00.000Z");
    const ref = scopeThreadRef(target.environmentId, target.id);
    expect(resolveSideChatOpen(ref, target)).toEqual(parentRef);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef)?.kind,
    ).toBe("side-chat");
    expect(useSideChatStore.getState().selectedSideChats[scopedThreadKey(parentRef)]).toBe(
      target.id,
    );
    expect(resolveSideChatOpen(parentRef, parent)).toBe(parentRef);
  });

  it("picks the newest live side chat of the parent", () => {
    const older = side("older", "2026-10-13T01:00:00.000Z");
    const newer = side("newer", "2026-10-13T02:00:00.000Z");
    const deleted = side("deleted", "2026-10-13T03:00:00.000Z", {
      deletedAt: "2026-10-13T03:05:00.000Z",
    });
    expect(findSideChatThread([parent, older, newer, deleted], parentRef)?.id).toBe("newer");
  });

  it("finds nothing for a thread without a side chat", () => {
    const other = { ...side("other", "2026-10-13T01:00:00.000Z"), sideChatOf: ThreadId.make("x") };
    expect(findSideChatThread([parent, other], parentRef)).toBeNull();
  });

  it("does not offer a side chat inside a side chat", () => {
    expect(canOpenSideChat(parent)).toBe(true);
    expect(canOpenSideChat(side("nested", "2026-10-13T01:00:00.000Z"))).toBe(false);
    expect(canOpenSideChat(null)).toBe(false);
  });
});

describe("sideChatParentStatus", () => {
  type Parent = Parameters<typeof sideChatParentStatus>[0];
  const parent = (overrides: Partial<Parent> = {}): Parent => ({
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    goal: null,
    ...overrides,
  });
  const runtime = (status: NonNullable<Parent["runtime"]>["status"]) => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-24T07:30:00.000Z",
  });
  const latestRun = (status: NonNullable<Parent["latestRun"]>["status"]) => ({
    runId: RunId.make("run:1"),
    status,
    requestedAt: null,
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  });
  const pausedGoal = { objective: "ship nightly", status: "paused" as const };

  it("shows the parent working while its turn runs, ahead of a paused goal", () => {
    expect(sideChatParentStatus(parent({ runtime: runtime("running"), goal: pausedGoal }))).toEqual(
      { label: "Working", tone: "active" },
    );
  });

  it("shows what the parent needs from the user first", () => {
    expect(
      sideChatParentStatus(parent({ runtime: runtime("running"), hasPendingApprovals: true })),
    ).toEqual({ label: "Needs approval", tone: "attention" });
    expect(
      sideChatParentStatus(parent({ runtime: runtime("running"), hasPendingUserInput: true })),
    ).toEqual({ label: "Needs input", tone: "attention" });
  });

  it("tells an interrupted, failed, or paused parent apart from an idle one", () => {
    expect(sideChatParentStatus(parent({ latestRun: latestRun("interrupted") })).label).toBe(
      "Interrupted",
    );
    expect(sideChatParentStatus(parent({ latestRun: latestRun("failed") })).label).toBe("Failed");
    expect(sideChatParentStatus(parent({ latestRun: latestRun("completed") })).label).toBe("Idle");
    expect(
      sideChatParentStatus(parent({ latestRun: latestRun("interrupted"), goal: pausedGoal })).label,
    ).toBe("Goal paused");
  });
});
