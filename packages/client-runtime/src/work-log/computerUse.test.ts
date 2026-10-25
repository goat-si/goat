import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computerUseDisplayInput,
  computerUseItemResult,
  computerUseNeedsResultDetail,
  computerUseObservedTarget,
  computerUseResult,
  computerUseRun,
  computerUseRunStatus,
} from "./computerUse.ts";
import { toolCallLines } from "./itemDetail.ts";
import { toolItemForDisplay } from "./presentation.ts";

const call = (toolName: string, input: unknown) =>
  ({ type: "dynamic_tool", toolName, input }) as unknown as OrchestrationV2TurnItem;

describe("computerUseRun", () => {
  it("recognizes cua-driver calls under every provider's naming", () => {
    for (const name of [
      "cua-driver.click",
      "mcp__cua-driver__click",
      "cua-driver_click",
      "cua-driver-c26f2f1fb6fbbcc2_click",
    ]) {
      expect(computerUseRun(call(name, { pid: 501, element_index: 4 }))?.summary).toBe(
        "Click element 4",
      );
    }
    expect(computerUseRun(call("mcp__weather__click", {}))).toBeUndefined();
  });

  it("summarizes each action and names its target", () => {
    expect(computerUseRun(call("cua-driver.get_window_state", { pid: 501, window_id: 7 }))).toEqual(
      {
        tool: "get_window_state",
        summary: "Look at a window",
        target: "Process 501, window 7",
        observes: true,
      },
    );
    // A settled wait returns its fresh final sample's screenshot, like a window look.
    expect(
      computerUseRun(call("cua-driver.wait_for_window_settle", { pid: 501, window_id: 7 })),
    ).toEqual({
      tool: "wait_for_window_settle",
      summary: "Wait for a window to settle",
      target: "Process 501, window 7",
      observes: true,
    });
    expect(computerUseRun(call("cua-driver.click", { pid: 501, x: 10, y: 20 }))?.summary).toBe(
      "Click at 10, 20",
    );
    expect(
      computerUseRun(call("cua-driver.press_key", { pid: 1, key: "s", modifiers: ["cmd"] }))
        ?.summary,
    ).toBe("Press cmd+s");
    expect(
      computerUseRun(call("cua-driver.hotkey", { pid: 1, keys: ["cmd", "tab"] }))?.summary,
    ).toBe("Press cmd+tab");
    expect(computerUseRun(call("cua-driver.scroll", { pid: 1, direction: "down" }))?.summary).toBe(
      "Scroll down",
    );
    expect(computerUseRun(call("cua-driver.launch_app", { name: "Finder" }))).toMatchObject({
      summary: "Open Finder",
      target: "Finder",
      observes: false,
    });
  });

  it("never repeats typed text, which can be a password", () => {
    const run = computerUseRun(call("cua-driver.type_text", { pid: 1, text: "hunter2" }));
    expect(run?.summary).toBe("Type 7 characters");
    expect(JSON.stringify(run)).not.toContain("hunter2");
  });
});

describe("computerUseObservedTarget", () => {
  it("names the app and window an observation reported", () => {
    expect(
      computerUseObservedTarget({
        content: [],
        structuredContent: { app_name: "Finder", window_title: "Downloads" },
      }),
    ).toBe("Downloads in Finder");
    expect(computerUseObservedTarget({ app_name: "Finder" })).toBe("Finder");
    expect(computerUseObservedTarget([{ type: "text", text: "x" }])).toBeNull();
    // GOAT moves the structured fields into JSON text beside a screenshot (#1154).
    const folded = JSON.stringify({ app_name: "Finder", window_title: "Downloads" });
    expect(
      computerUseObservedTarget([
        { type: "text", text: folded },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ]),
    ).toBe("Downloads in Finder");
    expect(
      computerUseObservedTarget({ content: [{ type: "text", text: "{not json" }] }),
    ).toBeNull();
  });
});

describe("computerUseRunStatus", () => {
  it("maps tool lifecycle to the card's status", () => {
    expect(computerUseRunStatus("inProgress")).toBe("running");
    expect(computerUseRunStatus("completed")).toBe("succeeded");
    expect(computerUseRunStatus("failed")).toBe("failed");
    expect(computerUseRunStatus("declined")).toBe("denied");
    expect(computerUseRunStatus("stopped")).toBe("stopped");
    expect(computerUseRunStatus(undefined)).toBeNull();
  });
});

describe("computerUseResult", () => {
  const settle = computerUseRun(
    call("cua-driver.wait_for_window_settle", { pid: 501, window_id: 7 }),
  );
  const structured = (outcome: string, reason: string) => ({
    structuredContent: { pid: 501, window_id: 7, settle: { outcome, reason } },
  });

  it("a settle wait that completed without settling is not shown as done (#1585)", () => {
    expect(
      computerUseResult(settle, "succeeded", structured("unsupported", "private_or_unknown_focus")),
    ).toEqual({
      status: "unsettled",
      note: "Window did not settle: focus is private or unknown",
    });
    expect(computerUseResult(settle, "succeeded", structured("pending", "deadline"))).toEqual({
      status: "unsettled",
      note: "Window did not settle before the deadline",
    });
    expect(
      computerUseResult(settle, "succeeded", structured("destroyed", "window_destroyed")),
    ).toEqual({
      status: "unsettled",
      note: "Window closed before it settled",
    });
  });

  it("reads the outcome from folded JSON text or the helper's own summary line", () => {
    // A privacy refusal names the check that failed after the known reason.
    expect(
      computerUseResult(
        settle,
        "succeeded",
        structured("unsupported", "private_or_unknown_focus:tree_children_unsupported:AXGroup"),
      ).note,
    ).toBe(
      "Window did not settle: focus is private or unknown (tree children unsupported: AXGroup)",
    );
    expect(
      computerUseResult(
        settle,
        "succeeded",
        structured(
          "unsupported",
          "private_or_unknown_focus:tree_children_unreadable:AXGroup:err25204,tree_role:AXUnknown",
        ),
      ).note,
    ).toBe(
      "Window did not settle: focus is private or unknown (tree children unreadable: AXGroup: err25204; tree role: AXUnknown)",
    );
    // The read summary after a refusal is diagnostic detail, not something the card shows.
    expect(
      computerUseResult(
        settle,
        "succeeded",
        structured(
          "unsupported",
          "private_or_unknown_focus:tree_role:AXUnknown,seen:AXButton:sub_absent:kids_unsupported:x53",
        ),
      ).note,
    ).toBe("Window did not settle: focus is private or unknown (tree role: AXUnknown)");
    // An expanded row has only the projected output, which keeps just the outcome.
    expect(
      computerUseResult(settle, "succeeded", {
        settle: { outcome: "pending", reason: "deadline" },
      }),
    ).toEqual({
      status: "unsettled",
      note: "Window did not settle before the deadline",
    });
    const folded = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            settle: { outcome: "unsupported", reason: "observer_unavailable" },
          }),
        },
      ],
    };
    expect(computerUseResult(settle, "succeeded", folded)?.note).toBe(
      "Window did not settle: observer unavailable",
    );
    const summary = [
      {
        type: "text",
        text: "Notification settle: pending (deadline). Quiet does not establish task completion.",
      },
    ];
    expect(computerUseResult(settle, "succeeded", summary)?.status).toBe("unsettled");
    // OpenCode keeps the summary as a plain string; an AX notification name is part of the reason.
    expect(
      computerUseResult(
        settle,
        "succeeded",
        "Notification settle: unsupported (notification_unsupported:AXMoved). Quiet does not establish task completion.",
      ),
    ).toEqual({
      status: "unsettled",
      note: "Window did not settle: notification unsupported:AXMoved",
    });
  });

  it("a card keeps the wire's outcome when the fetched detail was cut short", () => {
    const wire = { settle: { outcome: "pending", reason: "deadline" } };
    // Detail over its byte limit arrives as a truncated string with neither the block nor the line.
    const truncated = '{"content":[{"type":"text","text":"{\\"tree\\":\\"xxxx…';
    expect(computerUseItemResult(settle, "succeeded", wire, truncated)).toEqual({
      status: "unsettled",
      note: "Window did not settle before the deadline",
    });
    // Without a wire outcome, as from an older server, the fetched detail still counts.
    const full = "Notification settle: unsupported (observer_unavailable).";
    expect(computerUseItemResult(settle, "succeeded", undefined, full).status).toBe("unsettled");
  });

  it("an expanded card still fetches a settle result the wire carried no outcome for", () => {
    // Wire output from a server that predates compact settle outcomes.
    expect(computerUseNeedsResultDetail(settle, { isError: true })).toBe(true);
    expect(computerUseNeedsResultDetail(settle, undefined)).toBe(true);
    expect(
      computerUseNeedsResultDetail(settle, { settle: { outcome: "pending", reason: "deadline" } }),
    ).toBe(false);
    const click = computerUseRun(call("cua-driver.click", { pid: 1, x: 1, y: 1 }));
    expect(computerUseNeedsResultDetail(click, undefined)).toBe(false);
  });

  it("a settled wait, other tools and other lifecycles keep their status", () => {
    expect(computerUseResult(settle, "succeeded", structured("settled", "quiet_window"))).toEqual({
      status: "succeeded",
      note: null,
    });
    expect(computerUseResult(settle, "failed", structured("unsupported", "x"))).toEqual({
      status: "failed",
      note: null,
    });
    const click = computerUseRun(call("cua-driver.click", { pid: 1, x: 1, y: 1 }));
    expect(computerUseResult(click, "succeeded", structured("unsupported", "x"))).toEqual({
      status: "succeeded",
      note: null,
    });
    expect(computerUseResult(settle, null, undefined)).toEqual({ status: null, note: null });
  });
});

describe("computerUseDisplayInput", () => {
  it("shows only the length of typed text in the expanded row and its copy text", () => {
    expect(computerUseDisplayInput("cua-driver.type_text", { pid: 1, text: "hunter2" })).toEqual({
      pid: 1,
      text: "7 characters",
    });
    expect(
      computerUseDisplayInput("mcp__cua-driver__set_value", {
        pid: 1,
        element_index: 3,
        value: "x",
      }),
    ).toEqual({ pid: 1, element_index: 3, value: "1 character" });
    const click = { pid: 1, text: "Submit" };
    expect(computerUseDisplayInput("cua-driver.click", click)).toBe(click);
    const other = { text: "not typed into a screen" };
    expect(computerUseDisplayInput("mcp__notes__type_text", other)).toBe(other);
    // Mobile's full detail and long-press copy serialize this display item.
    const shown = toolItemForDisplay(call("cua-driver.type_text", { pid: 1, text: "hunter2" }));
    expect(JSON.stringify(shown)).not.toContain("hunter2");
  });

  it("masks an ACP child's enveloped call and reads the server's redacted input", () => {
    const envelope = { server: "cua-driver", tool: "type_text", arguments: { text: "hunter2" } };
    const child = call("cua-driver.type_text", envelope);
    expect(JSON.stringify(toolItemForDisplay(child))).not.toContain("hunter2");
    const lines = toolCallLines({
      args: computerUseDisplayInput("cua-driver.type_text", envelope),
    });
    expect(JSON.stringify(lines)).not.toContain("hunter2");
    expect(computerUseRun(child)?.summary).toBe("Type 7 characters");
    // The server sends a marker: the card and row show its length.
    const marker = { text: { redactedCharacters: 7 } };
    expect(computerUseRun(call("cua-driver.type_text", marker))?.summary).toBe("Type 7 characters");
    expect(computerUseDisplayInput("cua-driver.type_text", marker)).toEqual({
      text: "7 characters",
    });
    // Raw text that reads like a label is measured, never trusted.
    const lookalike = { text: "123 characters" };
    expect(computerUseRun(call("cua-driver.type_text", lookalike))?.summary).toBe(
      "Type 14 characters",
    );
    expect(computerUseDisplayInput("cua-driver.type_text", lookalike)).toEqual({
      text: "14 characters",
    });
  });
});
