import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const SCHEMA: Readonly<Record<string, ReadonlySet<string>>> = {
  click: new Set([
    "session",
    "target",
    "element_token",
    "x",
    "y",
    "button",
    "count",
    "modifier",
    "action",
    "delivery_mode",
  ]),
  press_key: new Set(["session", "target", "element_token", "key", "modifiers", "delivery_mode"]),
  type_text: new Set([
    "session",
    "target",
    "element_token",
    "text",
    "inter_char_delay_ms",
    "delivery_mode",
  ]),
  invoke_menu: new Set(["session", "pid", "window_id", "path"]),
};

const checked = (tool: string) => (args: Record<string, unknown>) => {
  const unknown = Object.keys(args).filter((key) => !SCHEMA[tool]?.has(key));
  if (unknown.length > 0)
    return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(", ")}`);
  return { effect: "confirmed", evidence: ["driver:acted"] };
};

const kakaoApps = {
  apps: [{ pid: 77, name: "KakaoTalk", bundle_id: "com.kakao.KakaoTalkMac" }],
};
const kakaoWindows = {
  windows: [
    {
      pid: 77,
      window_id: 81407,
      title: "김병준",
      bounds: { x: 0, y: 0, width: 500, height: 700 },
    },
  ],
};
const kakaoState = {
  pid: 77,
  window_id: 81407,
  snapshot_id: "s0000000k",
  elements_complete: false,
  tree_format: "both",
  tree_markdown: '[0] AXWindow "김병준"\n  [1] AXTextArea "Enter a message"\n  [2] AXButton "전송"',
  elements: [
    {
      element_index: 0,
      element_token: "s0000000k:0",
      role: "AXWindow",
      label: "김병준",
      frame: { x: 0, y: 0, w: 500, h: 700 },
    },
    {
      element_index: 1,
      element_token: "s0000000k:1",
      role: "AXTextArea",
      label: "Enter a message",
      parent_index: 0,
      frame: { x: 10, y: 620, w: 400, h: 60 },
    },
    {
      element_index: 2,
      element_token: "s0000000k:2",
      role: "AXButton",
      label: "전송",
      parent_index: 0,
      frame: { x: 420, y: 630, w: 60, h: 40 },
    },
  ],
};

it.live(
  "click, press, type and menu with { send: true } in KakaoTalk reach the driver without send in the driver arguments, while calls without it or in a guarded batch send nothing",
  () => {
    const { host, sent } = fixture({
      list_apps: kakaoApps,
      list_windows: kakaoWindows,
      get_window_state: kakaoState,
      click: checked("click"),
      press_key: checked("press_key"),
      type_text: checked("type_text"),
      invoke_menu: checked("invoke_menu"),
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const refused = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'com.kakao.KakaoTalkMac', window_id: 81407});
          await app.observe();
          const calls = [
            app.click(2),
            app.press('Enter', 1),
            app.type('hi\\n', 1),
            app.menu(['Chat', 'Send']),
          ];
          const results = [];
          for (const p of calls) {
            try { await p; results.push('ok'); }
            catch (e) { results.push(e.nothingSent); }
          }
          const batch = await Promise.allSettled([app.type('draft', 1), app.click(2)]);
          return { results, batch: batch.map((b) => b.status === 'fulfilled' ? b.value.verdict : b.reason.nothingSent) };`,
      });
      expect(refused.value).toEqual({
        results: [true, true, true, true],
        batch: ["confirmed", true],
      });
      // Only the draft type in the batch reached the driver; all 5 unapproved sends were blocked.
      expect(
        sent
          .map((entry) => entry.tool)
          .filter((tool) => !["list_apps", "list_windows", "get_window_state"].includes(tool)),
      ).toEqual(["type_text"]);

      const allowed = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'com.kakao.KakaoTalkMac', window_id: 81407});
          await app.observe();
          await app.click(2, { send: true });
          await app.press('Enter', 1, { send: true });
          await app.type('hi\\n', 1, { send: true });
          await app.menu(['Chat', 'Send'], { send: true });
          return true;`,
      });
      expect(allowed).toMatchObject({ status: "completed", value: true });
      const actions = sent.slice(-4);
      expect(actions.map((entry) => entry.tool)).toEqual([
        "click",
        "press_key",
        "type_text",
        "invoke_menu",
      ]);
      for (const entry of actions) expect(entry.args).not.toHaveProperty("send");
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);
