import { OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@goat/contracts";
import { COMPUTER_USE_TOOL_SOURCE } from "@goat/shared/toolActivity";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { makeCallApps } from "./ComputerUseCallApps.ts";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const at = DateTime.makeUnsafe("2026-10-28T00:00:00.000Z");

type DynamicToolItem = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;

const driverCall = (toolName: string, input: unknown): DynamicToolItem => ({
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool",
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  toolName,
  input,
  toolSurface: "computer",
  toolSource: COMPUTER_USE_TOOL_SOURCE,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

const calculator = {
  key: "native-app:com.apple.calculator",
  name: "Calculator",
  kind: "computer",
  icon: { _tag: "native-app", app: { _tag: "app-id", appId: "com.apple.calculator" } },
};

describe("ComputerUseCallApps", () => {
  it("presents a pid-only call as the app its proxy labelled, in every provider's call shape", () => {
    const apps = makeCallApps();
    apps.admitted(
      { pid: 42, window_id: 3 },
      { bundleId: "com.apple.calculator", name: "Calculator" },
    );

    for (const item of [
      driverCall("cua-driver.click", { pid: 42, window_id: 3, element_index: 5 }),
      driverCall("mcp__cua-driver__get_window_state", {
        target: { kind: "window", pid: 42, window_id: 3 },
      }),
      // ACP children name the call cua-driver.<tool> and keep it in a {server, tool, arguments} envelope.
      driverCall("cua-driver.zoom", { server: "cua-driver", tool: "zoom", arguments: { pid: 42 } }),
    ]) {
      const presented = decodeTurnItem(apps.present(item));
      expect(presented.toolSource).toEqual(calculator);
      expect(presented.toolIcon).toEqual(calculator.icon);
    }
  });

  it("forgets a pid whose next admitted call came unlabelled, so a reused pid never shows the old app", () => {
    const apps = makeCallApps();
    apps.admitted({ pid: 42 }, { bundleId: "com.apple.calculator", name: "Calculator" });
    apps.admitted({ pid: 42, window_id: 9 }, undefined);
    const reused = driverCall("cua-driver.click", { pid: 42, window_id: 9 });
    expect(apps.present(reused)).toBe(reused);
  });

  it("names an app the call itself names, and leaves an unknown pid generic", () => {
    const apps = makeCallApps();
    const launch = apps.present(
      driverCall("cua-driver.launch_app", { bundle_id: "com.apple.TextEdit", name: "TextEdit" }),
    );
    expect(launch.toolSource).toMatchObject({
      key: "native-app:com.apple.textedit",
      name: "TextEdit",
    });
    // A launch by bundle id alone takes the app's name from its answer once it settles.
    const byId = apps.present({
      ...driverCall("cua-driver.launch_app", { bundle_id: "com.apple.calculator" }),
      output: { bundle_id: "com.apple.calculator", name: "Calculator", pid: 42 },
    });
    expect(byId.toolSource).toEqual(calculator);
    // OpenCode keeps a call's answer as JSON text.
    const asText = apps.present({
      ...driverCall("cua-driver.launch_app", { bundle_id: "com.apple.calculator" }),
      output: JSON.stringify({ bundle_id: "com.apple.calculator", name: "Calculator", pid: 42 }),
    });
    expect(asText.toolSource).toEqual(calculator);

    // A bundle id stands in for a missing name only within the name's 160-character limit.
    const id160 = `com.${"a".repeat(156)}`;
    const named = apps.present(driverCall("cua-driver.launch_app", { bundle_id: id160 }));
    expect(decodeTurnItem(named).toolSource?.name).toBe(id160);
    const long = driverCall("cua-driver.launch_app", { bundle_id: `${id160}b` });
    expect(apps.present(long)).toBe(long);

    const unknown = driverCall("cua-driver.click", { pid: 7, window_id: 1 });
    expect(apps.present(unknown)).toBe(unknown);
  });

  it("names an app with no bundle id by its display name, without an icon for a path", () => {
    const apps = makeCallApps();
    apps.admitted({ pid: 9 }, { name: "gedit" });
    apps.admitted({ pid: 10 }, { name: "/usr/bin/xterm" });

    expect(
      decodeTurnItem(apps.present(driverCall("cua-driver.click", { pid: 9 }))).toolSource,
    ).toEqual({
      key: "native-app-name:gedit",
      name: "gedit",
      kind: "computer",
      icon: { _tag: "native-app", app: { _tag: "display-name", displayName: "gedit" } },
    });
    const path = decodeTurnItem(apps.present(driverCall("cua-driver.click", { pid: 10 })));
    expect(path.toolSource).toEqual({
      key: "native-app-name:/usr/bin/xterm",
      name: "/usr/bin/xterm",
      kind: "computer",
    });
    expect(path.toolIcon).toBeUndefined();
  });
});
