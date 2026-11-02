import { describe, expect, it } from "@effect/vitest";

import {
  browserAppName,
  guardBrowserAppSurface,
  type SurfaceTarget,
} from "./BrowserAppSurfaceGuard.ts";

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

  it("refuses address bar text input but allows clicking a verified address bar", () => {
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
      }),
    ).toEqual({});
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
});
