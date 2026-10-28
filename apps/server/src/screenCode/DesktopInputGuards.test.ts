import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";

const finderState = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s0000000f",
  elements_complete: false,
  tree_format: "both",
  tree_markdown:
    '[0] AXWindow "Finder"\n  [1] AXOutline "Sidebar"\n  [2] AXTable "Files"\n    [3] AXRow "Row 1"\n      [41] AXTextField "Math Problem 13 × 2 + 7 = 33"\n  [50] AXTextField "Search"',
  elements: [
    {
      element_index: 0,
      element_token: "s0000000f:0",
      role: "AXWindow",
      label: "Finder",
      frame: { x: 0, y: 0, w: 800, h: 600 },
    },
    {
      element_index: 2,
      element_token: "s0000000f:2",
      role: "AXTable",
      label: "Files",
      parent_index: 0,
      frame: { x: 100, y: 50, w: 600, h: 500 },
    },
    {
      element_index: 3,
      element_token: "s0000000f:3",
      role: "AXRow",
      label: "Row 1",
      parent_index: 2,
      frame: { x: 100, y: 60, w: 600, h: 24 },
    },
    {
      element_index: 41,
      element_token: "s0000000f:41",
      role: "AXTextField",
      label: "Math Problem 13 × 2 + 7 = 33",
      parent_index: 3,
      frame: { x: 120, y: 60, w: 300, h: 20 },
    },
    {
      element_index: 50,
      element_token: "s0000000f:50",
      role: "AXTextField",
      label: "Search",
      parent_index: 0,
      frame: { x: 500, y: 10, w: 200, h: 24 },
    },
  ],
};

const activityMonitorState = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s0000000a",
  elements_complete: false,
  tree_format: "both",
  tree_markdown:
    '[0] AXWindow "Activity Monitor"\n  [1] AXOutline "Processes"\n    [2] AXRow "Row"\n      [3] AXTextField "WindowServer"',
  elements: [
    {
      element_index: 0,
      element_token: "s0000000a:0",
      role: "AXWindow",
      label: "Activity Monitor",
      frame: { x: 0, y: 0, w: 800, h: 600 },
    },
    {
      element_index: 1,
      element_token: "s0000000a:1",
      role: "AXOutline",
      label: "Processes",
      parent_index: 0,
      frame: { x: 0, y: 50, w: 800, h: 550 },
    },
    {
      element_index: 2,
      element_token: "s0000000a:2",
      role: "AXRow",
      label: "Row",
      parent_index: 1,
      frame: { x: 0, y: 60, w: 800, h: 20 },
    },
    {
      element_index: 3,
      element_token: "s0000000a:3",
      role: "AXTextField",
      label: "WindowServer",
      parent_index: 2,
      frame: { x: 20, y: 60, w: 200, h: 20 },
    },
  ],
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
const kakaoState = (args: Record<string, unknown>) =>
  args.include_accessibility_tree === false
    ? goat2WindowState(args, { pid: 77, window_id: 81407, snapshot_id: "s0000000k" })
    : {
        pid: 77,
        window_id: 81407,
        snapshot_id: "s0000000k",
        elements_complete: false,
        tree_format: "both",
        tree_markdown:
          '[0] AXWindow "김병준"\n  [1] AXSearchField "채팅방 검색"\n  [2] AXTextArea "Enter a message"\n  [3] AXTextField ""\n  [4] AXButton "전송"\n  [5] AXButton ""\n  [6] AXButton "Profile"\n  [7] AXMenuItem "Paste"\n  [8] AXButton "Offscreen"\n  [9] AXButton "ZeroSize"',
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
            role: "AXSearchField",
            label: "채팅방 검색",
            parent_index: 0,
            frame: { x: 10, y: 40, w: 200, h: 28 },
          },
          {
            element_index: 2,
            element_token: "s0000000k:2",
            role: "AXTextArea",
            label: "Enter a message",
            parent_index: 0,
            frame: { x: 10, y: 620, w: 400, h: 60 },
          },
          {
            element_index: 3,
            element_token: "s0000000k:3",
            role: "AXTextField",
            label: "",
            parent_index: 0,
            frame: { x: 10, y: 580, w: 200, h: 24 },
          },
          {
            element_index: 4,
            element_token: "s0000000k:4",
            role: "AXButton",
            label: "전송",
            parent_index: 0,
            frame: { x: 420, y: 630, w: 60, h: 40 },
          },
          {
            element_index: 5,
            element_token: "s0000000k:5",
            role: "AXButton",
            label: "",
            parent_index: 0,
            frame: { x: 420, y: 580, w: 30, h: 30 },
          },
          {
            element_index: 6,
            element_token: "s0000000k:6",
            role: "AXButton",
            label: "Profile",
            parent_index: 0,
            frame: { x: 20, y: 80, w: 40, h: 40 },
          },
          {
            element_index: 7,
            element_token: "s0000000k:7",
            role: "AXMenuItem",
            label: "Paste",
            parent_index: 0,
            frame: { x: 100, y: 100, w: 120, h: 22 },
          },
          {
            element_index: 8,
            element_token: "s0000000k:8",
            role: "AXButton",
            label: "Offscreen",
            parent_index: 0,
            frame: { x: 900, y: 900, w: 50, h: 24 },
          },
          {
            element_index: 9,
            element_token: "s0000000k:9",
            role: "AXButton",
            label: "ZeroSize",
            parent_index: 0,
            frame: { x: 50, y: 50, w: 0, h: 24 },
          },
        ],
      };

const byIndex = (observed: unknown, index: number): ScreenElementRef => {
  const found = (
    observed as { elements: Array<{ index: number; ref: ScreenElementRef }> }
  ).elements.find((item) => item.index === index);
  if (!found) throw new Error(`Missing element [${index}]`);
  return found.ref;
};

it.effect("typing into a list's name cell is refused before dispatch and names setValue", () =>
  Effect.gen(function* () {
    for (const [stateFixture, cellIndex] of [
      [finderState, 41],
      [activityMonitorState, 3],
    ] as const) {
      const { host, sent } = fixture({ get_window_state: stateFixture });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const cellRef = byIndex(observed.value, cellIndex);
      const before = sent.length;
      const refused = yield* host
        .invoke(call("type_text", { text: "renamed", elementRef: cellRef }, ref), context)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(refused.nextStep).toContain(`setValue(${cellIndex}, value)`);
      expect(sent.slice(before)).toEqual([]);
    }
  }),
);

it.effect("an unaddressed type right after clicking a table cell is refused", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ get_window_state: finderState });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const cellRef = byIndex(observed.value, 41);
    yield* host.invoke(call("click", { elementRef: cellRef }, ref), context);
    const before = sent.length;
    const refused = yield* host
      .invoke(call("type_text", { text: "renamed" }, ref), context)
      .pipe(Effect.flip);
    expect(refused).toMatchObject({ code: "invalid_argument", effectStarted: false });
    expect(refused.nextStep).toContain("setValue(41, value)");
    expect(sent.slice(before)).toEqual([]);
  }),
);

it.effect("setValue on a Finder name cell and typing into a plain text field go through", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ get_window_state: finderState });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const cellRef = byIndex(observed.value, 41);
    const searchRef = byIndex(observed.value, 50);
    const set = yield* host.invoke(
      call("set_value", { value: "renamed", elementRef: cellRef }, ref),
      context,
    );
    expect(set.category).toBe("confirmed");
    const typed = yield* host.invoke(
      call("type_text", { text: "query", elementRef: searchRef }, ref),
      context,
    );
    expect(typed.category).toBe("confirmed");
    expect(sent.slice(-2).map((entry) => entry.tool)).toEqual(["set_value", "type_text"]);
  }),
);

it.effect(
  "Enter in any canonical form or unaddressed type without a target is refused in KakaoTalk",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_apps: kakaoApps,
        list_windows: kakaoWindows,
        get_window_state: kakaoState,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "com.kakao.KakaoTalkMac", window_id: 81407 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("get_window_state", {}, ref), context);
      const before = sent.length;
      for (const keyArgs of [
        { key: "Return" },
        { key: "Enter" },
        { key: "KP_Enter" },
        { key: "numpadenter" },
        { key: "kpenter" },
        { key: "\r" },
        { key: "shift+Enter" },
        { key: "Enter", modifiers: ["command"] },
      ]) {
        const refused = yield* host
          .invoke(call("press_key", keyArgs, ref), context)
          .pipe(Effect.flip);
        expect(refused.effectStarted).toBe(false);
        expect(refused.nextStep).toContain("Name the field");
      }
      const unaddressedType = yield* host
        .invoke(call("type_text", { text: "hello" }, ref), context)
        .pipe(Effect.flip);
      expect(unaddressedType.effectStarted).toBe(false);
      expect(unaddressedType.nextStep).toContain("Name the field");
      expect(sent.slice(before)).toEqual([]);

      // Positive controls: Escape without a target goes through in KakaoTalk; Enter in TextEdit is unchanged.
      const esc = yield* host.invoke(call("press_key", { key: "Escape" }, ref), context);
      expect(esc.category).toBe("confirmed");

      const editor = fixture();
      const editorBound = yield* editor.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const editorEnter = yield* editor.host.invoke(
        call("press_key", { key: "Enter" }, editorBound.value as ScreenTargetRef),
        context,
      );
      expect(editorEnter.category).toBe("confirmed");
    }),
);

it.effect(
  "in KakaoTalk, composer Enter, control chars, unknown labels, Send buttons, menus and point clicks follow sendPolicy",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_apps: kakaoApps,
        list_windows: kakaoWindows,
        get_window_state: kakaoState,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "com.kakao.KakaoTalkMac", window_id: 81407 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const searchRef = byIndex(observed.value, 1);
      const composerRef = byIndex(observed.value, 2);
      const unknownRef = byIndex(observed.value, 3);
      const sendBtnRef = byIndex(observed.value, 4);
      const unnamedBtnRef = byIndex(observed.value, 5);
      const profileBtnRef = byIndex(observed.value, 6);

      // Search field: plain typing and Enter without send: true are allowed; newline/Tab need send: true.
      expect(
        (yield* host.invoke(
          call("type_text", { text: "김병준", elementRef: searchRef }, ref),
          context,
        )).category,
      ).toBe("confirmed");
      expect(
        (yield* host.invoke(
          call("press_key", { key: "Return", elementRef: searchRef }, ref),
          context,
        )).category,
      ).toBe("confirmed");
      for (const controlText of ["hello\n", "hello\t", "hello\r"]) {
        const refused = yield* host
          .invoke(call("type_text", { text: controlText, elementRef: searchRef }, ref), context)
          .pipe(Effect.flip);
        expect(refused.effectStarted).toBe(false);
        expect(refused.nextStep).toContain("{ send: true }");
      }

      // Composer and unknown-label field: plain typing drafts; Enter or control char needs send: true.
      expect(
        (yield* host.invoke(
          call("type_text", { text: "draft message", elementRef: composerRef }, ref),
          context,
        )).category,
      ).toBe("confirmed");
      for (const targetRef of [composerRef, unknownRef]) {
        const noSend = yield* host
          .invoke(call("press_key", { key: "Enter", elementRef: targetRef }, ref), context)
          .pipe(Effect.flip);
        expect(noSend.effectStarted).toBe(false);
        expect(noSend.nextStep).toContain("{ send: true }");
        const withSend = yield* host.invoke(
          call("press_key", { key: "Enter", elementRef: targetRef, send: true }, ref),
          context,
        );
        expect(withSend.category).toBe("confirmed");
      }

      // Send-named or unnamed button needs send: true; profile button does not.
      for (const btn of [sendBtnRef, unnamedBtnRef]) {
        const noSend = yield* host
          .invoke(call("click", { elementRef: btn }, ref), context)
          .pipe(Effect.flip);
        expect(noSend.effectStarted).toBe(false);
        expect(noSend.nextStep).toContain("{ send: true }");
      }
      expect(
        (yield* host.invoke(call("click", { elementRef: profileBtnRef }, ref), context)).category,
      ).toBe("confirmed");

      // Point clicks and point right-clicks in KakaoTalk are refused even with send: true.
      yield* host.observe(call("screenshot", {}, ref), context);
      const beforePoints = sent.length;
      for (const method of ["click", "right_click"] as const) {
        const refused = yield* host
          .invoke(call(method, { x: 50, y: 50, send: true }, ref), context)
          .pipe(Effect.flip);
        expect(refused.effectStarted).toBe(false);
        expect(refused.nextStep).toContain("Use element numbers in KakaoTalk");
      }
      expect(sent.slice(beforePoints)).toEqual([]);
    }),
);

it.effect(
  "cmd+v in every modifier alias, Paste menu paths, and any input addressed to a Paste menu item are refused",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        list_apps: kakaoApps,
        list_windows: kakaoWindows,
        get_window_state: kakaoState,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "com.kakao.KakaoTalkMac", window_id: 81407 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const pasteItemRef = byIndex(observed.value, 7);
      const before = sent.length;

      for (const chord of [
        { key: "v", modifiers: ["cmd"] },
        { key: "V", modifiers: ["command", "shift"] },
        { key: "super+v" },
        { key: "meta+v" },
        { key: "win+v" },
        { key: "cmd+option+shift+v" },
      ]) {
        const refused = yield* host
          .invoke(call("press_key", chord, ref), context)
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "permission_denied", effectStarted: false });
        expect(refused.nextStep).toContain("type(text, N)");
      }

      for (const path of [
        ["Edit", "Paste"],
        ["Edit", "Paste and Match Style"],
        ["편집", "붙여넣기"],
        ["편집", "스타일 붙여넣기"],
      ]) {
        const refused = yield* host
          .invoke(call("invoke_menu", { path }, ref), context)
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "permission_denied", effectStarted: false });
        expect(refused.nextStep).toContain("type(text, N)");
      }

      for (const action of [
        call("click", { elementRef: pasteItemRef }, ref),
        call("right_click", { elementRef: pasteItemRef }, ref),
        call("press_key", { key: "Enter", elementRef: pasteItemRef }, ref),
        call("press_key", { key: "space", elementRef: pasteItemRef }, ref),
        call("type_text", { text: "a", elementRef: pasteItemRef }, ref),
        call("set_value", { value: "a", elementRef: pasteItemRef }, ref),
      ]) {
        const refused = yield* host.invoke(action, ref ? context : context).pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "permission_denied", effectStarted: false });
        expect(refused.nextStep).toContain("type(text, N)");
      }

      expect(sent.slice(before)).toEqual([]);
    }),
);

it.effect("a click on an element with no visible click bounds is refused before dispatch", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_apps: kakaoApps,
      list_windows: kakaoWindows,
      get_window_state: kakaoState,
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "com.kakao.KakaoTalkMac", window_id: 81407 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const offscreenRef = byIndex(observed.value, 8);
    const zeroSizeRef = byIndex(observed.value, 9);
    const before = sent.length;
    for (const [idx, targetRef] of [
      [8, offscreenRef],
      [9, zeroSizeRef],
    ] as const) {
      const refused = yield* host
        .invoke(call("click", { elementRef: targetRef }, ref), context)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(refused.nextStep).toContain(`Element ${idx} has no visible click bounds`);
    }
    expect(sent.slice(before)).toEqual([]);
  }),
);

it.effect(
  "binding a closed window returns target_missing with detail window_gone and the discover step, while a failed window listing stays downstream_failure",
  () =>
    Effect.gen(function* () {
      const closed = fixture({ list_windows: { windows: [] } });
      const missing = yield* closed.host
        .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
        .pipe(Effect.flip);
      expect(missing).toMatchObject({
        code: "target_missing",
        detail: "window_gone",
        effectStarted: false,
      });
      expect(missing.nextStep).toContain("screen.discover()");

      const failed = fixture({
        list_windows: new DriverError({ code: "enumerator_failed" }, "CGWindowList failed"),
      });
      const broken = yield* failed.host
        .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
        .pipe(Effect.flip);
      expect(broken.code).toBe("downstream_failure");
      expect(broken.detail).toBeUndefined();
    }),
);
