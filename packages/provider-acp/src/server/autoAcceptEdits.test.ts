import { describe, it, expect } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";
import {
  makeAcpUnreadToolCalls,
  unreadToolCallUpdate,
  withTrackedChangedPaths,
  withUnknownChangedPaths,
  MAX_UNREAD_TOOL_CALLS,
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import { acpChangedPathsOfToolCall, acpPermissionDisposition } from "./clientPolicy.ts";
import { autoAcceptPolicyRequest } from "./autoAcceptEdits.ts";

describe("ACP tracked file changes", () => {
  const trackedToolCall = (
    ...updates: ReadonlyArray<Record<string, unknown>>
  ): AcpToolCallState | undefined => {
    let tracked: AcpToolCallState | undefined;
    for (const [index, update] of updates.entries()) {
      // Shapes the wire accepts through the schema's open variants, so the types do not name them.
      const notification = {
        sessionId: "session-1",
        update: {
          sessionUpdate: index === 0 ? "tool_call" : "tool_call_update",
          toolCallId: "tool-1",
          ...(index === 0 ? { title: "Edit", kind: "edit" } : {}),
          ...update,
        },
      } as EffectAcpSchema.SessionNotification;
      for (const event of parseSessionUpdateEvent(notification).events) {
        if ("toolCall" in event && event.toolCall !== undefined) {
          tracked = mergeToolCallState(tracked, event.toolCall);
        }
      }
    }
    return tracked;
  };
  const idOnlyRequest: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "session-1",
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    toolCall: { toolCallId: "tool-1" },
  };
  const changedPathsWith = (
    tracked: AcpToolCallState | undefined,
    request: EffectAcpSchema.RequestPermissionRequest = idOnlyRequest,
  ) => acpChangedPathsOfToolCall(withTrackedChangedPaths(request, tracked).toolCall);

  it("gives an id-only permission request every path its tool call's notifications named", () => {
    const tracked = trackedToolCall({
      locations: [{ path: "/work/a.ts", line: 3 }],
      content: [{ type: "diff", path: "/elsewhere/b.ts", newText: "b" }],
      rawInput: { file_path: "/elsewhere/c.ts" },
    });
    expect(changedPathsWith(tracked)).toEqual(["/work/a.ts", "/elsewhere/b.ts", "/elsewhere/c.ts"]);
    expect(
      changedPathsWith(tracked, {
        ...idOnlyRequest,
        toolCall: { toolCallId: "tool-1", locations: [{ path: "/work/d.ts" }] },
      }),
    ).toEqual(["/work/d.ts", "/work/a.ts", "/elsewhere/b.ts", "/elsewhere/c.ts"]);
    expect(withTrackedChangedPaths(idOnlyRequest, undefined)).toBe(idOnlyRequest);
    expect(withTrackedChangedPaths(idOnlyRequest, trackedToolCall({}))).toBe(idOnlyRequest);
  });

  it("reads the session and tool call of a dropped tool-call notification", () => {
    const dropped = (update: unknown, sessionId: unknown = "session-1") =>
      unreadToolCallUpdate("session/update", { sessionId, update });
    for (const sessionUpdate of ["tool_call", "tool_call_update", "tool_call_content_chunk"]) {
      expect(dropped({ sessionUpdate, toolCallId: "tool-1", locations: [{ path: 7 }] })).toEqual({
        sessionId: "session-1",
        toolCallId: "tool-1",
      });
    }
    // An id or session that is not a non-empty string is not read.
    expect(dropped({ sessionUpdate: "tool_call_update", toolCallId: 7 })).toEqual({
      sessionId: "session-1",
    });
    expect(dropped({ sessionUpdate: "tool_call", toolCallId: "" }, 7)).toEqual({});
    // A kind that cannot be read may have been a tool call.
    expect(dropped({ toolCallId: "tool-1" })).toEqual({
      sessionId: "session-1",
      toolCallId: "tool-1",
    });
    expect(dropped("not an update")).toEqual({ sessionId: "session-1" });
    expect(unreadToolCallUpdate("session/update", null)).toEqual({});
    // Other kinds and other methods are not tool-call notifications.
    expect(dropped({ sessionUpdate: "usage_update", toolCallId: "tool-1" })).toBeUndefined();
    expect(dropped({ sessionUpdate: "a_later_kind" })).toBeUndefined();
    expect(
      unreadToolCallUpdate("elicitation/complete", {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1" },
      }),
    ).toBeUndefined();
  });

  it("records the tool calls a dropped notification may have described", () => {
    const unread = makeAcpUnreadToolCalls();
    unread.add({ sessionId: "session-1", toolCallId: "tool-1" }, ["tool-9"]);
    expect(unread.has("session-1", "tool-1")).toBe(true);
    expect(unread.has("session-1", "tool-9")).toBe(false);
    // Tool ids are only unique within a session.
    expect(unread.has("session-2", "tool-1")).toBe(false);

    // Without a tool call id, every tool call in the session (including unseen ones whose first
    // update was dropped) is tainted, while other sessions stay unaffected.
    unread.add({ sessionId: "session-1" }, ["tool-2", "tool-3"]);
    expect(unread.has("session-1", "tool-2")).toBe(true);
    expect(unread.has("session-1", "tool-3")).toBe(true);
    expect(unread.has("session-1", "tool-4")).toBe(true);
    expect(unread.has("session-2", "tool-4")).toBe(false);

    // Without a session, the named tool call is recorded for every session.
    unread.add({ toolCallId: "tool-5" }, []);
    expect(unread.has("session-1", "tool-5")).toBe(true);
    expect(unread.has("session-2", "tool-5")).toBe(true);
    expect(unread.has("session-2", "tool-6")).toBe(false);

    // Without either session or tool call id, every tool call in every session is tainted.
    unread.add({}, []);
    expect(unread.has("session-2", "tool-6")).toBe(true);
    expect(unread.has("session-3", "never-seen")).toBe(true);
  });

  it("asks instead of auto-approving after an undecodable first update with unreadable toolCallId or sessionId", () => {
    const policy = {
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      cwd: "/work",
      autoAcceptEdits: true,
    };
    const safeRequest: EffectAcpSchema.RequestPermissionRequest = {
      sessionId: "session-1",
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      toolCall: {
        toolCallId: "tool-first",
        kind: "edit",
        locations: [{ path: "/work/safe.txt" }],
      },
    };

    const sessionDropped = makeAcpUnreadToolCalls();
    const droppedFirst = unreadToolCallUpdate("session/update", {
      sessionId: "session-1",
      update: { sessionUpdate: "tool_call", toolCallId: 7 },
    });
    expect(droppedFirst).toEqual({ sessionId: "session-1" });
    sessionDropped.add(droppedFirst!, []);
    expect(
      acpPermissionDisposition(
        policy,
        autoAcceptPolicyRequest(safeRequest, undefined, sessionDropped),
      ),
    ).toBe("ask");

    const globalDropped = makeAcpUnreadToolCalls();
    const droppedUnknownSession = unreadToolCallUpdate("session/update", null);
    expect(droppedUnknownSession).toEqual({});
    globalDropped.add(droppedUnknownSession!, []);
    expect(
      acpPermissionDisposition(
        policy,
        autoAcceptPolicyRequest(safeRequest, undefined, globalDropped),
      ),
    ).toBe("ask");
  });

  it("counts every tool call as unread once too many are recorded", () => {
    const unread = makeAcpUnreadToolCalls();
    for (let index = 0; index < MAX_UNREAD_TOOL_CALLS; index += 1) {
      unread.add({ sessionId: "session-1", toolCallId: `tool-${index}` }, []);
    }
    unread.add({ sessionId: "session-1", toolCallId: "tool-0" }, []);
    expect(unread.has("session-1", "never-named")).toBe(false);
    unread.add({ sessionId: "session-1", toolCallId: "one-more" }, []);
    expect(unread.has("session-1", "one-more")).toBe(true);
    expect(unread.has("session-2", "never-named")).toBe(true);
  });

  it("makes the paths of a tool call with a dropped notification unknown", () => {
    const tracked = trackedToolCall({ locations: [{ path: "/work/a.ts" }] });
    expect(changedPathsWith(tracked)).toEqual(["/work/a.ts"]);
    expect(changedPathsWith(withUnknownChangedPaths(tracked, "tool-1"))).toBe("unknown");
    // A tool call none of whose notifications was read is unknown too.
    expect(changedPathsWith(withUnknownChangedPaths(undefined, "tool-1"))).toBe("unknown");
    expect(
      changedPathsWith(withUnknownChangedPaths(undefined, "tool-1"), {
        ...idOnlyRequest,
        toolCall: { toolCallId: "tool-1", locations: [{ path: "/work/d.ts" }] },
      }),
    ).toBe("unknown");
  });

  it("keeps a tracked tool call's paths as sent while its card shows them trimmed", () => {
    const tracked = trackedToolCall({ locations: [{ path: "/work/target " }] });
    expect(tracked?.data.locations).toEqual([{ path: "/work/target" }]);
    expect(changedPathsWith(tracked)).toEqual(["/work/target "]);
  });

  it("remembers that a tracked tool call's paths were incomplete", () => {
    const inside = [{ path: "/work/a.ts" }];
    for (const update of [
      { locations: [...inside, { path: " " }] },
      { locations: [...inside, { path: "" }] },
      { locations: [...inside, { path: 7 }] },
      { locations: [...inside, {}] },
      { locations: inside, rawInput: { path: 7 } },
      { locations: inside, content: [{ type: "diff", changes: [{ operation: "_swap" }] }] },
      { locations: inside, content: [{ type: "_t3_unknown", originalType: "_patch", raw: {} }] },
    ]) {
      const tracked = trackedToolCall(update);
      // The card still lists the paths it can show.
      expect(tracked?.data.locations).toEqual(inside);
      expect(changedPathsWith(tracked)).toBe("unknown");
      // A request that names complete paths itself does not make the call's own set complete.
      expect(
        changedPathsWith(tracked, {
          ...idOnlyRequest,
          toolCall: { toolCallId: "tool-1", locations: inside },
        }),
      ).toBe("unknown");
      // Nor does a later update that names only readable paths.
      expect(changedPathsWith(trackedToolCall(update, { locations: inside }))).toBe("unknown");
    }
  });

  it("keeps a tracked tool call's earlier paths when a later update replaces or clears them", () => {
    const replaced = trackedToolCall(
      { locations: [{ path: "/elsewhere/a.ts" }] },
      { locations: [{ path: "/work/a.ts" }] },
    );
    expect(replaced?.data.locations).toEqual([{ path: "/work/a.ts" }]);
    expect(changedPathsWith(replaced)).toEqual(["/elsewhere/a.ts", "/work/a.ts"]);

    const cleared = trackedToolCall(
      { locations: [{ path: "/elsewhere/a.ts" }], rawInput: { path: "/elsewhere/b.ts" } },
      { locations: null, rawInput: null, content: null },
      { status: "in_progress" },
    );
    expect(cleared?.data.locations).toEqual([]);
    expect(changedPathsWith(cleared)).toEqual(["/elsewhere/a.ts", "/elsewhere/b.ts"]);

    const added = trackedToolCall(
      { locations: [{ path: "/work/a.ts" }] },
      { content: [{ type: "diff", path: "/elsewhere/b.ts", newText: "b" }] },
    );
    expect(changedPathsWith(added)).toEqual(["/work/a.ts", "/elsewhere/b.ts"]);
  });

  it("treats a tracked tool call that names very many paths as unknown", () => {
    const paths = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({ path: `/work/${prefix}-${index}.ts` }));
    expect(changedPathsWith(trackedToolCall({ locations: paths(256, "a") }))).toHaveLength(256);
    expect(changedPathsWith(trackedToolCall({ locations: paths(257, "a") }))).toBe("unknown");
    expect(
      changedPathsWith(
        trackedToolCall({ locations: paths(200, "a") }, { locations: paths(200, "b") }),
      ),
    ).toBe("unknown");
  });
});
