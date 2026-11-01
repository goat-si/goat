import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  excludeGlobalAgentThreads,
  isGlobalAgentRoute,
  isGlobalAgentThread,
  isGoatBotRoute,
  isGoatBotThread,
  legacyGlobalAgentRoute,
} from "./globalAgentRoute";

const ENV = "env-1" as EnvironmentId;
const OTHER_ENV = "env-2" as EnvironmentId;
const REF = { environmentId: ENV, threadId: "thread-1" as ThreadId, draftId: "draft-1" as DraftId };
const serverTarget = (environmentId: EnvironmentId, threadId: string) => ({
  kind: "server" as const,
  threadRef: scopeThreadRef(environmentId, threadId as ThreadId),
});
const draftTarget = (draftId: string) => ({ kind: "draft" as const, draftId: draftId as DraftId });

describe("isGlobalAgentThread", () => {
  it("matches the saved thread", () => {
    expect(isGlobalAgentThread({ environmentId: ENV, id: "thread-1" }, REF)).toBe(true);
  });
  it("ignores the same id on another machine", () => {
    expect(isGlobalAgentThread({ environmentId: OTHER_ENV, id: "thread-1" }, REF)).toBe(false);
  });
  it("matches nothing without a saved ref", () => {
    expect(isGlobalAgentThread({ environmentId: ENV, id: "thread-1" }, null)).toBe(false);
  });
});

describe("excludeGlobalAgentThreads", () => {
  const threads = [
    { environmentId: ENV, id: "thread-1" },
    { environmentId: ENV, id: "thread-2" },
    { environmentId: OTHER_ENV, id: "thread-1" },
  ];
  it("removes only the global agent", () => {
    expect(excludeGlobalAgentThreads(threads, REF)).toEqual([threads[1], threads[2]]);
  });
  it("keeps every thread without a saved ref", () => {
    expect(excludeGlobalAgentThreads(threads, null)).toEqual(threads);
  });
});

describe("isGlobalAgentRoute", () => {
  it('is never active on "/"', () => {
    expect(isGlobalAgentRoute("/", null, REF)).toBe(false);
  });
  it("is active on the global draft", () => {
    expect(isGlobalAgentRoute("/draft/draft-1", draftTarget("draft-1"), REF)).toBe(true);
  });
  it("is inactive on another draft", () => {
    expect(isGlobalAgentRoute("/draft/draft-2", draftTarget("draft-2"), REF)).toBe(false);
  });
  it("is active on the global thread", () => {
    expect(isGlobalAgentRoute("/env-1/thread-1", serverTarget(ENV, "thread-1"), REF)).toBe(true);
  });
  it("is inactive on another thread", () => {
    expect(isGlobalAgentRoute("/env-1/thread-2", serverTarget(ENV, "thread-2"), REF)).toBe(false);
  });
  it("is inactive on the same thread id on another machine", () => {
    expect(isGlobalAgentRoute("/env-2/thread-1", serverTarget(OTHER_ENV, "thread-1"), REF)).toBe(
      false,
    );
  });
  it("is inactive without a saved ref", () => {
    expect(isGlobalAgentRoute("/env-1/thread-1", serverTarget(ENV, "thread-1"), null)).toBe(false);
  });
});

describe("legacyGlobalAgentRoute", () => {
  it("opens the old global agent's thread directly, never through /", () => {
    expect(legacyGlobalAgentRoute(REF, { archivedAt: null, deletedAt: null }, false)).toEqual({
      kind: "thread",
      environmentId: ENV,
      threadId: REF.threadId,
    });
  });

  it("falls back to its unsent draft, and to nothing once it is gone", () => {
    expect(legacyGlobalAgentRoute(REF, null, true)).toEqual({
      kind: "draft",
      draftId: REF.draftId,
    });
    expect(legacyGlobalAgentRoute(REF, { archivedAt: "2026-10-12T00:00:00Z" }, false)).toBeNull();
    expect(legacyGlobalAgentRoute(null, null, true)).toBeNull();
  });
});

describe("GOAT Bot routes", () => {
  const BOT = { environmentId: ENV, threadId: "bot" as ThreadId };

  it("recognizes the bot thread and leaves it out of thread lists", () => {
    const threads = [
      { environmentId: ENV, id: "bot" },
      { environmentId: ENV, id: "thread-1" },
      { environmentId: ENV, id: "thread-2" },
    ];
    expect(isGoatBotThread({ environmentId: ENV, id: "bot" }, BOT)).toBe(true);
    expect(isGoatBotThread({ environmentId: OTHER_ENV, id: "bot" }, BOT)).toBe(false);
    expect(excludeGlobalAgentThreads(threads, REF, BOT).map((thread) => thread.id)).toEqual([
      "thread-2",
    ]);
  });

  it("is active on /bot and on the bot thread", () => {
    expect(isGoatBotRoute("/bot", null, null)).toBe(true);
    expect(isGoatBotRoute("/env-1/bot", serverTarget(ENV, "bot"), BOT)).toBe(true);
    expect(isGoatBotRoute("/env-1/thread-1", serverTarget(ENV, "thread-1"), BOT)).toBe(false);
    expect(isGoatBotRoute("/env-1/bot", serverTarget(ENV, "bot"), null)).toBe(false);
  });
});
