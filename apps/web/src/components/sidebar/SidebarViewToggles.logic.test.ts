import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { GlobalAgentRef } from "../../globalAgentStore";
import { DraftId } from "../../composerDraftStore";
import { makeThreadFixture } from "../../test-fixtures";
import { hasSidebarActivityAttention } from "./SidebarViewToggles.logic";

const parent = makeThreadFixture({ id: ThreadId.make("parent") });
const globalAgentRef: GlobalAgentRef = {
  environmentId: parent.environmentId,
  threadId: parent.id,
  draftId: DraftId.make("global-draft"),
};
const child = makeThreadFixture({
  id: ThreadId.make("child"),
  lineage: {
    rootThreadId: parent.id,
    parentThreadId: parent.id,
    relationshipToParent: "subagent",
  },
  source: { ...parent.source, creationSource: "mcp" },
  hasPendingUserInput: true,
});

describe("sidebar activity attention", () => {
  it("only asks for attention for approvals and user input", () => {
    expect(hasSidebarActivityAttention([], null)).toBe(false);
    expect(hasSidebarActivityAttention([parent], null)).toBe(false);
    expect(hasSidebarActivityAttention([{ ...parent, hasPendingApprovals: true }], null)).toBe(
      true,
    );
    expect(hasSidebarActivityAttention([{ ...parent, hasPendingUserInput: true }], null)).toBe(
      true,
    );
  });

  it("does not flag running work or unread completions", () => {
    const running = makeThreadFixture({
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: parent.providerInstanceId,
        providerName: null,
        lastError: null,
        lastErrorClass: null,
        updatedAt: parent.updatedAt,
      },
    });
    expect(hasSidebarActivityAttention([running], null)).toBe(false);
    const unread = { ...parent, lastVisitedAt: null, latestAssistantMessageAt: parent.updatedAt };
    expect(hasSidebarActivityAttention([unread], null)).toBe(false);
  });

  it("excludes archived and deleted parents", () => {
    const attention = { ...parent, hasPendingApprovals: true };
    expect(
      hasSidebarActivityAttention([{ ...attention, archivedAt: parent.updatedAt }], null),
    ).toBe(false);
    expect(hasSidebarActivityAttention([{ ...attention, deletedAt: parent.updatedAt }], null)).toBe(
      false,
    );
  });

  it("includes attention on a visible parent's delegated child", () => {
    expect(hasSidebarActivityAttention([parent, child], null)).toBe(true);
    expect(
      hasSidebarActivityAttention(
        [parent, { ...child, hasPendingUserInput: false, hasPendingApprovals: true }],
        null,
      ),
    ).toBe(true);
    expect(hasSidebarActivityAttention([child], null)).toBe(false);
  });

  it("ignores archived, deleted and provider-native children", () => {
    for (const hiddenChild of [
      { ...child, archivedAt: child.updatedAt },
      { ...child, deletedAt: child.updatedAt },
      { ...child, source: { ...child.source, creationSource: "provider" as const } },
    ]) {
      expect(hasSidebarActivityAttention([parent, hiddenChild], null)).toBe(false);
    }
  });

  it("does not attach another environment's child to a matching thread ID", () => {
    const remoteChild = { ...child, environmentId: EnvironmentId.make("remote") };
    expect(hasSidebarActivityAttention([parent, remoteChild], null)).toBe(false);
    const remoteParent = { ...parent, environmentId: remoteChild.environmentId };
    expect(hasSidebarActivityAttention([remoteParent, remoteChild], null)).toBe(true);
  });

  it("excludes the global agent and its child attention by scoped identity", () => {
    expect(
      hasSidebarActivityAttention([{ ...parent, hasPendingApprovals: true }], globalAgentRef),
    ).toBe(false);
    expect(hasSidebarActivityAttention([parent, child], globalAgentRef)).toBe(false);
    expect(
      hasSidebarActivityAttention(
        [
          {
            ...parent,
            environmentId: EnvironmentId.make("remote"),
            hasPendingUserInput: true,
          },
        ],
        globalAgentRef,
      ),
    ).toBe(true);
  });

  it("clears the indicator when the delegated request is answered", () => {
    expect(hasSidebarActivityAttention([parent, child], null)).toBe(true);
    expect(
      hasSidebarActivityAttention([parent, { ...child, hasPendingUserInput: false }], null),
    ).toBe(false);
  });
});

it("excludes the bot and its delegated child attention only in the bot environment", () => {
  const botRef = {
    environmentId: parent.environmentId,
    threadId: parent.id,
    projectId: ProjectId.make("scratch"),
  };
  expect(
    hasSidebarActivityAttention([{ ...parent, hasPendingApprovals: true }], null, botRef),
  ).toBe(false);
  expect(hasSidebarActivityAttention([parent, child], null, botRef)).toBe(false);
  expect(
    hasSidebarActivityAttention(
      [{ ...parent, environmentId: EnvironmentId.make("remote"), hasPendingUserInput: true }],
      null,
      botRef,
    ),
  ).toBe(true);
});
