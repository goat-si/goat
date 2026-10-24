import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computerUseDisplayInput,
  computerUseObservedTarget,
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
    // The server already sent "7 characters": the card and row keep the real length.
    const redacted = call("cua-driver.type_text", { pid: 1, text: "7 characters" });
    expect(computerUseRun(redacted)?.summary).toBe("Type 7 characters");
    expect(computerUseDisplayInput("cua-driver.type_text", { text: "7 characters" })).toEqual({
      text: "7 characters",
    });
  });
});
