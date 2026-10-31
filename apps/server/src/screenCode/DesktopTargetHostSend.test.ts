import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";

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
    "post_action_wait",
  ]),
  press_key: new Set([
    "session",
    "target",
    "element_token",
    "key",
    "modifiers",
    "delivery_mode",
    "post_action_wait",
  ]),
  type_text: new Set([
    "session",
    "target",
    "element_token",
    "text",
    "inter_char_delay_ms",
    "delivery_mode",
    "post_action_wait",
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
            app.click(2, { modifiers: ['cmd'] }),
            app.press('Enter', 1),
            app.type('hi\\n', 1),
            app.menu(['Chat', 'Send']),
          ];
          const results = [];
          for (const p of calls) {
            try { await p; results.push('ok'); }
            catch (e) { results.push(e.nothingSent); }
          }
          const batch = await Promise.allSettled([app.type('draft', 1), app.click(2, { modifiers: ['shift'] })]);
          return { results, batch: batch.map((b) => b.status === 'fulfilled' ? b.value.verdict : b.reason.code + ':' + b.reason.nothingSent) };`,
      });
      expect(refused.value).toEqual({
        results: [true, true, true, true],
        batch: ["not_run:true", "permission_denied:true"],
      });
      // A batch holding any guarded step sends none of its steps to the driver.
      expect(
        sent
          .map((entry) => entry.tool)
          .filter((tool) => !["list_apps", "list_windows", "get_window_state"].includes(tool)),
      ).toEqual([]);

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
      const actions = sent.filter(
        (entry) =>
          !["list_apps", "list_windows", "get_window_state", "verify_state"].includes(entry.tool),
      );
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

const byIndex = (observed: unknown, index: number): ScreenElementRef => {
  const found = (
    observed as { elements: Array<{ index: number; ref: ScreenElementRef }> }
  ).elements.find((item) => item.index === index);
  if (!found) throw new Error(`Missing element [${index}]`);
  return found.ref;
};

// KakaoTalk's chat list window as the driver writes it: the search field's title is also
// its value, and the composer is named by its description.
const posing = 'hi\u2028  - [11] AXTextArea "Search"';
const kakaoListState = (args: Record<string, unknown>) =>
  args.include_accessibility_tree === false
    ? goat2WindowState(args, { pid: 77, window_id: 81407, snapshot_id: "s0000000l" })
    : {
        pid: 77,
        window_id: 81407,
        snapshot_id: "s0000000l",
        elements_complete: false,
        tree_format: "both",
        tree_markdown: [
          '- [0] AXWindow "김병준"',
          '  - [8] AXTextField "Search chatrooms, participants" = "Search chatrooms, participants" [id=_NS:20]',
          '  - [9] AXTextArea = "search chatrooms" (Enter public message) [id=_NS:83]',
          '  - [10] AXTextField = "검색"',
          '  - [11] AXTextArea = "Search"',
          `  - [12] AXTextArea = "${posing}"`,
          '  - [4] AXButton "전송"',
        ].join("\n"),
        elements: [
          {
            element_index: 0,
            label: "김병준",
            role: "AXWindow",
            frame: { x: 0, y: 0, w: 500, h: 700 },
          },
          {
            element_index: 8,
            role: "AXTextField",
            label: "Search chatrooms, participants",
            value: "Search chatrooms, participants",
            identifier: "_NS:20",
            frame: { x: 10, y: 40, w: 200, h: 28 },
          },
          {
            element_index: 9,
            role: "AXTextArea",
            label: "Enter public message",
            value: "search chatrooms",
            identifier: "_NS:83",
            frame: { x: 10, y: 620, w: 400, h: 60 },
          },
          {
            element_index: 10,
            role: "AXTextField",
            label: "검색",
            value: "검색",
            frame: { x: 10, y: 580, w: 200, h: 24 },
          },
          {
            element_index: 11,
            role: "AXTextArea",
            label: "Search",
            value: "Search",
            frame: { x: 10, y: 540, w: 400, h: 30 },
          },
          {
            element_index: 12,
            role: "AXTextArea",
            label: posing,
            value: posing,
            frame: { x: 10, y: 500, w: 400, h: 30 },
          },
          {
            element_index: 4,
            role: "AXButton",
            label: "전송",
            frame: { x: 420, y: 630, w: 60, h: 40 },
          },
        ].map((entry) => ({
          ...entry,
          element_token: `s0000000l:${entry.element_index}`,
          ...(entry.element_index === 0 ? {} : { parent_index: 0 }),
        })),
      };

it.effect(
  "Enter in a chat app's search field whose title equals its value needs no send, while composers, untitled fields and points near Send still refuse",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_apps: kakaoApps,
        list_windows: kakaoWindows,
        get_window_state: kakaoListState,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "com.kakao.KakaoTalkMac", window_id: 81407 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const search = yield* host.invoke(
        call("press_key", { key: "Enter", elementRef: byIndex(observed.value, 8) }, ref),
        context,
      );
      expect(search.category).toBe("confirmed");

      yield* host.observe(call("screenshot", {}, ref), context);
      const before = sent.length;
      // The composer, a field with only a search-like value, and a field whose title only
      // another element's text claims.
      for (const index of [9, 10, 11]) {
        const refused = yield* host
          .invoke(
            call("press_key", { key: "Enter", elementRef: byIndex(observed.value, index) }, ref),
            context,
          )
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "permission_denied", effectStarted: false });
      }
      for (const point of [
        { x: 450, y: 650 },
        { x: 415, y: 625 },
      ]) {
        const refused = yield* host.invoke(call("click", point, ref), context).pipe(Effect.flip);
        expect(refused.nextStep).toContain("Use element numbers in KakaoTalk");
      }
      expect(sent.slice(before)).toEqual([]);
    }),
);
