import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";

import {
  browserAppName,
  browserSurfaceRefusal,
  guardBrowserAppSurface,
  readBrowserSurface,
  type BrowserSurfaceHolder,
  type SurfaceTarget,
} from "./BrowserAppSurfaceGuard.ts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const target = (overrides: Partial<SurfaceTarget> = {}): SurfaceTarget => ({
  role: "AXButton",
  ancestors: [{ role: "AXWebArea" }, { role: "AXWindow" }],
  ancestryComplete: true,
  ...overrides,
});

const browsers = [
  ["com.google.Chrome", "Google Chrome"],
  ["com.brave.Browser", "Brave Browser"],
  ["com.microsoft.edgemac", "Microsoft Edge"],
  ["company.thebrowser.Browser", "Arc"],
  ["com.apple.Safari", "Safari"],
  ["org.mozilla.firefox", "Firefox"],
] as const;

describe("browserAppName", () => {
  it("recognizes browser bundle IDs case-insensitively and browser names, but not Finder", () => {
    for (const [bundleId, name] of browsers) {
      expect(browserAppName(bundleId.toUpperCase())).toBe(name);
      expect(browserAppName(name)).toBe(name);
    }
    expect(browserAppName("COM.Google.Chrome")).toBe("Google Chrome");
    expect(browserAppName("com.apple.finder")).toBeUndefined();
    expect(browserAppName("Finder")).toBeUndefined();
  });
});

describe("guardBrowserAppSurface", () => {
  it("refuses a Chrome web-content click with the required refusal fields and a message", () => {
    const result = guardBrowserAppSurface({
      method: "click",
      appId: "com.google.Chrome",
      target: target(),
    });
    expect(result.refused).toMatchObject({
      code: "browser_surface_required",
      nothingSent: true,
      effectStarted: false,
      reason: "web_content",
      app: "Google Chrome",
      nextStep:
        "Use screen.tab() or screen.openTab({ url }) to navigate and interact with web pages over CDP.",
    });
    expect(typeof result.refused?.message).toBe("string");
  });

  it("refuses a web area target with or without the AX prefix", () => {
    for (const role of ["AXWebArea", "webarea"]) {
      const result = guardBrowserAppSurface({
        method: "click",
        appId: "com.google.Chrome",
        target: target({ role, ancestors: [{ role: "AXWindow" }] }),
      });
      expect(result.refused?.reason).toBe("web_content");
    }
  });

  it("refuses each input method on web content in all six browsers", () => {
    for (const [appId] of browsers) {
      for (const method of ["click", "type_text", "set_value", "press_key"]) {
        expect(guardBrowserAppSurface({ method, appId, target: target() }).refused?.reason).toBe(
          "web_content",
        );
      }
    }
  });

  it("allows Finder web areas and non-input methods on browser web content", () => {
    expect(
      guardBrowserAppSurface({ method: "click", appId: "com.apple.finder", target: target() }),
    ).toEqual({});
    for (const method of ["screenshot", "scroll", "get_accessibility_tree"]) {
      expect(
        guardBrowserAppSurface({ method, appId: "com.google.Chrome", target: target() }),
      ).toEqual({});
    }
  });

  it("allows clicking or pressing a key on Chrome's remote debugging dialog", () => {
    const dialogButton = target({
      label: "Allow",
      ancestors: [{ role: "AXWindow", subrole: "AXDialog" }],
      ancestryComplete: false,
    });
    for (const method of ["click", "press_key"]) {
      expect(
        guardBrowserAppSurface({ method, appId: "com.google.Chrome", target: dialogButton }),
      ).toEqual({});
    }
  });

  it("allows text input in a native file sheet even with incomplete ancestry", () => {
    for (const label of ["Where", "Save As"]) {
      for (const method of ["type_text", "set_value"]) {
        expect(
          guardBrowserAppSurface({
            method,
            appId: "com.google.Chrome",
            target: target({
              role: "AXTextField",
              label,
              ancestors: [{ role: "AXSheet" }, { role: "AXWindow" }],
              ancestryComplete: false,
            }),
          }),
        ).toEqual({});
      }
    }
  });

  it("refuses address bar text input and clicks, which open its navigating suggestions", () => {
    const chromeAddress = target({
      role: "AXTextField",
      label: "Address and search bar",
      ancestors: [{ role: "AXToolbar" }, { role: "AXWindow" }],
      ancestryComplete: true,
    });
    expect(
      guardBrowserAppSurface({
        method: "type_text",
        appId: "com.google.Chrome",
        target: chromeAddress,
      }).refused?.reason,
    ).toBe("address_bar");
    expect(
      guardBrowserAppSurface({
        method: "click",
        appId: "com.google.Chrome",
        target: chromeAddress,
      }).refused?.reason,
    ).toBe("address_bar");
    expect(
      guardBrowserAppSurface({
        method: "set_value",
        appId: "com.apple.Safari",
        target: target({
          role: "AXTextField",
          identifier: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD",
          ancestors: [{ role: "AXToolbar" }, { role: "AXWindow" }],
        }),
      }).refused?.reason,
    ).toBe("address_bar");
  });

  it("allows a verified toolbar button and refuses buttons with incomplete ancestry", () => {
    const back = target({
      label: "Back",
      ancestors: [{ role: "AXToolbar" }, { role: "AXWindow" }],
    });
    expect(
      guardBrowserAppSurface({ method: "click", appId: "com.google.Chrome", target: back }),
    ).toEqual({});
    for (const ancestors of [back.ancestors, [{ role: "AXWindow" }]]) {
      expect(
        guardBrowserAppSurface({
          method: "click",
          appId: "com.google.Chrome",
          target: target({ label: "Back", ancestors, ancestryComplete: false }),
        }).refused?.reason,
      ).toBe("unverified_target");
    }
  });

  it("refuses missing, empty-role, and unknown targets as unverified", () => {
    for (const candidate of [undefined, target({ role: "" }), target({ role: "AXUnknown" })]) {
      expect(
        guardBrowserAppSurface({ method: "click", appId: "com.google.Chrome", target: candidate })
          .refused?.reason,
      ).toBe("unverified_target");
    }
  });

  it("allows a plain native document with complete ancestry", () => {
    expect(
      guardBrowserAppSurface({
        method: "click",
        appId: "com.google.Chrome",
        target: target({
          role: "AXDocument",
          ancestors: [{ role: "AXWindow" }],
          ancestryComplete: true,
        }),
      }),
    ).toEqual({});
  });

  it("refuses web content inside a sheet and treats page dialogs as unverified", () => {
    const inSheet = guardBrowserAppSurface({
      method: "click",
      appId: "com.apple.Safari",
      target: target({ ancestors: [{ role: "AXWebArea" }, { role: "AXSheet" }] }),
    });
    expect(inSheet.refused?.reason).toBe("web_content");
    const pageDialog = guardBrowserAppSurface({
      method: "click",
      appId: "com.google.Chrome",
      target: target({
        ancestors: [{ role: "AXGroup", subrole: "AXApplicationDialog" }, { role: "AXWindow" }],
        ancestryComplete: false,
      }),
    });
    expect(pageDialog.refused?.reason).toBe("unverified_target");
  });
});

const frame = (index: number) => ({ x: 10 + index * 40, y: 10, w: 30, h: 20 });
const entry = (
  index: number,
  role: string,
  label: string,
  extra: Record<string, unknown> = {},
) => ({
  element_index: index,
  element_token: "c1:" + index,
  role,
  label,
  frame: index === 0 ? { x: 0, y: 0, w: 800, h: 600 } : frame(index),
  ...(index === 0 ? {} : { parent_index: 0 }),
  ...extra,
});
/** Chrome-shaped: toolbar, an unnumbered web area the driver's parent_index skips, a save sheet, then more toolbar. */
const chromeState = (
  overrides: Record<string, unknown> = {},
  elementOverrides: Record<number, Record<string, unknown>> = {},
) => {
  const elements = [
    entry(0, "AXWindow", "Example - Google Chrome"),
    entry(1, "AXButton", "Back"),
    entry(2, "AXTextField", "Address and search bar"),
    entry(3, "AXLink", "Sign in"),
    entry(4, "AXSheet", "Save"),
    entry(5, "AXButton", "Save", { parent_index: 4 }),
    entry(6, "AXButton", "Reload"),
  ].map((each) => ({ ...each, ...elementOverrides[each.element_index] }));
  return {
    pid: 42,
    window_id: 7,
    snapshot_id: "c1",
    elements_complete: false,
    tree_format: "both",
    tree_markdown: [
      '- [0] AXWindow "Example - Google Chrome"',
      "  - AXGroup",
      '    - [1] AXButton "Back" [actions=[press]]',
      '    - [2] AXTextField "Address and search bar"',
      '  - AXWebArea "Example"',
      '    - [3] AXLink "Sign in" [actions=[press]]',
      '  - [4] AXSheet "Save"',
      '    - [5] AXButton "Save" [actions=[press]]',
      "  - AXToolbar",
      '    - [6] AXButton "Reload" [actions=[press]]',
    ].join("\n"),
    elements,
    ...overrides,
  };
};
const holder = (
  state: Record<string, unknown>,
  whole = true,
  snapshotId = "c1",
): BrowserSurfaceHolder => ({
  appId: "com.google.Chrome",
  snapshotId,
  browserSurface: new Map([["c1", readBrowserSurface(state, whole)]]),
});
const verdict = (bound: BrowserSurfaceHolder, method: string, index?: number, fresh = true) =>
  browserSurfaceRefusal(
    bound,
    method,
    index === undefined ? {} : { elementRef: { token: "c1:" + index } },
    (element) => (typeof element.token === "string" ? element.token : undefined),
    fresh,
  )?.detail;

describe("browser surface reads", () => {
  it("refuses page content and the address bar of a whole read while its toolbar and save sheet stay reachable", () => {
    const bound = holder(chromeState());
    expect(
      browserSurfaceRefusal(
        bound,
        "click",
        { elementRef: { token: "c1:3" } },
        (el) => String(el.token),
        true,
      ),
    ).toEqual({
      code: "browser_surface_required",
      effectStarted: false,
      detail: "web_content",
      message: expect.stringContaining("Google Chrome"),
      nextStep:
        "Use screen.tab() or screen.openTab({ url }) to navigate and interact with web pages over CDP.",
    });
    for (const method of ["click", "type_text", "set_value", "press_key"])
      expect(verdict(bound, method, 2), method).toBe("address_bar");
    // Reload follows the web area in the tree, so ancestry, not position, places it.
    for (const index of [1, 5, 6])
      expect(verdict(bound, "click", index), String(index)).toBeUndefined();
  });

  it("aims untargeted keys at the one focused element of the committed read and nothing else", () => {
    const focusedAddress = holder(chromeState({}, { 2: { focused: true } }));
    expect(verdict(focusedAddress, "type_text")).toBe("address_bar");
    expect(verdict(focusedAddress, "press_key")).toBe("address_bar");
    expect(verdict(holder(chromeState({}, { 1: { focused: true } })), "press_key")).toBeUndefined();
    expect(verdict(focusedAddress, "type_text", undefined, false)).toBe("unverified_target");
    expect(
      verdict(holder(chromeState({}, { 1: { focused: true }, 2: { focused: true } })), "type_text"),
    ).toBe("unverified_target");
    expect(verdict(holder(chromeState(), true, "c0"), "click", 1)).toBe("unverified_target");
    // A stale element reference is left to the input plan's stale_reference, never to focus.
    expect(
      browserSurfaceRefusal(
        focusedAddress,
        "type_text",
        { elementRef: { token: 7 } },
        () => undefined,
        true,
      ),
    ).toBeUndefined();
  });

  it("leaves targets of partial, degraded or mismatched reads unverified unless driver structure places them", () => {
    for (const bound of [
      holder(chromeState(), false),
      holder(chromeState({ degraded: true })),
      holder(chromeState({}, { 1: { role: "AXLink" } })),
      holder(chromeState({}, { 1: { parent_index: 6 } })),
    ]) {
      expect(verdict(bound, "click", 1)).toBe("unverified_target");
      expect(verdict(bound, "click", 3)).toBe("web_content");
    }
    // Without tree text nothing shows the web area the driver's parent_index skips.
    expect(verdict(holder(chromeState({ tree_markdown: "" })), "click", 3)).toBe(
      "unverified_target",
    );
    // The sheet comes from the driver's own parent_index, so a partial read still reaches it.
    expect(verdict(holder(chromeState(), false), "click", 5)).toBeUndefined();
  });

  it("does not touch other apps or unguarded methods", () => {
    const editor = { ...holder(chromeState()), appId: "org.example.Editor" };
    expect(verdict(editor, "click", 3)).toBeUndefined();
    expect(verdict(holder(chromeState()), "right_click", 3)).toBeUndefined();
  });
});

const chromeApps = { apps: [{ pid: 42, name: "Google Chrome", bundle_id: "com.google.Chrome" }] };
const byIndex = (observed: unknown, index: number): ScreenElementRef => {
  const found = (
    observed as { elements: Array<{ index: number; ref: ScreenElementRef }> }
  ).elements.find((item) => item.index === index);
  if (!found) throw new Error("Missing element " + index);
  return found.ref;
};
const observeChrome = (apps = chromeApps, state = chromeState()) =>
  Effect.gen(function* () {
    const connection = { id: "driver:1" };
    const made = fixture({ list_apps: apps, get_window_state: state }, connection);
    const bound = yield* made.host.bindApp(
      call("bind_app", { bundle_id: apps.apps[0]?.bundle_id ?? "", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observed = (yield* made.host.observe(call("get_window_state", {}, ref), context)).value;
    const input = (method: "click" | "set_value", index: number) =>
      call(method, { elementRef: byIndex(observed, index), value: "x" }, ref);
    const clicks = () =>
      made.sent.filter((sent) => sent.tool === "click" || sent.tool === "set_value");
    return { ...made, ref, connection, input, clicks };
  });

describe("DesktopTargetHost browser surface", () => {
  it.effect(
    "a driver restart refuses untargeted browser keys instead of sending them to the new driver",
    () =>
      Effect.gen(function* () {
        const { host, sent, ref, connection } = yield* observeChrome(
          chromeApps,
          chromeState({}, { 1: { focused: true } }),
        );
        connection.id = "driver:2";
        // The first attempt meets the restart; it also ended the read, so the next has nothing to stand on.
        for (const [keys, code] of [
          [call("press_key", { key: "a" }, ref), "stale_reference"],
          [call("type_text", { text: "a" }, ref), "browser_surface_required"],
        ] as const)
          expect(yield* host.invoke(keys, context).pipe(Effect.flip)).toMatchObject({
            code,
            effectStarted: false,
          });
        expect(
          sent.filter((each) => each.tool === "press_key" || each.tool === "type_text"),
        ).toEqual([]);
      }),
  );

  it.effect(
    "refuses page and address bar input before the driver, then needs a new read after any input or launch",
    () =>
      Effect.gen(function* () {
        const { host, input, clicks } = yield* observeChrome();
        for (const refused of [input("click", 3), input("set_value", 2)])
          expect(yield* host.invoke(refused, context).pipe(Effect.flip)).toMatchObject({
            code: "browser_surface_required",
            effectStarted: false,
          });
        expect(clicks()).toEqual([]);
        yield* host.invoke(input("click", 5), context);
        expect(clicks()).toHaveLength(1);
        const second = yield* observeChrome();
        yield* Effect.exit(
          second.host.invoke(call("launch_app", { bundle_id: "com.apple.finder" }), context),
        );
        expect(
          yield* second.host.invoke(second.input("click", 1), context).pipe(Effect.flip),
        ).toMatchObject({
          code: "browser_surface_required",
          detail: "unverified_target",
        });
        expect(second.clicks()).toEqual([]);
      }),
  );

  it.effect("clicks the same tree normally in an app that is not a browser", () =>
    Effect.gen(function* () {
      const { host, input, clicks } = yield* observeChrome({
        apps: [{ pid: 42, name: "Editor", bundle_id: "org.example.Editor" }],
      });
      yield* host.invoke(input("click", 3), context);
      expect(clicks()).toHaveLength(1);
    }),
  );

  it.live(
    "a cell catches the refusal with nothing sent, and a grouped batch with a second guarded input sends nothing",
    () => {
      const made = fixture({ list_apps: chromeApps, get_window_state: chromeState() });
      return Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
        const result = yield* service.runCell({
          ...turn,
          invocation: context.invocation,
          source: [
            "const app = await screen.app({bundle_id: 'com.google.Chrome', window_id: 7}); await app.observe();",
            "let link; try { await app.click(3); } catch (e) { link = {code: e.code, nothingSent: e.nothingSent, detail: e.detail, nextStep: e.nextStep}; }",
            "const batch = (await Promise.allSettled([app.click(1), app.click(1)])).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);",
            "await app.click(1);",
            "return {link, batch};",
          ].join("\n"),
        });
        expect(result.value).toEqual({
          link: {
            code: "browser_surface_required",
            nothingSent: true,
            detail: "web_content",
            nextStep:
              "Use screen.tab() or screen.openTab({ url }) to navigate and interact with web pages over CDP.",
          },
          batch: ["not_run:true", "browser_surface_required:true"],
        });
        expect(made.sent.filter((sent) => sent.tool === "click")).toHaveLength(1);
        yield* service.finishTurn({ ...turn, reason: "test" });
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher: createScreenDispatchRouter({ app: made.host }),
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
});
