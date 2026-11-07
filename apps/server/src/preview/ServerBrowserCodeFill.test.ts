import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import { fillCode } from "./ServerBrowserCodeFill.ts";

const withForm = (
  markup: string,
  run: (fixture: {
    fill: (changeOrigin?: boolean) => ReturnType<typeof fillCode>;
    value: (selector: string) => Promise<string>;
    masked: string[];
    protectedFields: Array<{ objectId: string; value: string }>;
  }) => Promise<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (b) => Effect.promise(() => b.close()),
      );
      const page = yield* Effect.promise(async () => {
        const context = await browser.newContext();
        await context.route("**/*", (route) =>
          route.fulfill({ contentType: "text/html", body: `<form>${markup}</form>` }),
        );
        const page = await context.newPage();
        await page.goto("https://code.test/");
        await page.locator("input").first().focus();
        return page;
      });
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const tree = yield* Effect.promise(() => cdp.send("Page.getFrameTree"));
      const world = yield* Effect.promise(() =>
        cdp.send("Page.createIsolatedWorld", {
          frameId: tree.frameTree.frame.id,
          worldName: "code-test",
        }),
      );
      const masked: string[] = [];
      const protectedFields: Array<{ objectId: string; value: string }> = [];
      yield* Effect.promise(() =>
        run({
          fill: (changeOrigin = false) =>
            fillCode({
              send: async (method, params, onDispatch) => {
                onDispatch?.();
                return Reflect.apply(cdp.send, cdp, [method, params]);
              },
              contextId: world.executionContextId,
              origin: changeOrigin ? "https://wrong.test" : "https://code.test",
              code: "123456",
              register: (value) => masked.push(value),
              protect: (field) => {
                protectedFields.push(field);
                return () => {
                  const i = protectedFields.indexOf(field);
                  if (i >= 0) protectedFields.splice(i, 1);
                };
              },
            }),
          value: (selector) => page.locator(selector).inputValue(),
          masked,
          protectedFields,
        }),
      );
    }),
  );

it.live("fills a section-prefixed code and protects its value", () =>
  withForm(
    '<input autocomplete="section-login one-time-code">',
    async ({ fill, value, masked, protectedFields }) => {
      const result = await fill();
      expect(result).toMatchObject({ filled: true, verdict: "confirmed" });
      expect(await value("input")).toBe("123456");
      expect(masked).toEqual(["123456"]);
      expect(protectedFields).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("123456");
    },
  ),
);

it.live("uses the focused eligible field as a fallback", () =>
  withForm('<input type="tel" maxlength="6">', async ({ fill, value }) => {
    expect(await fill()).toMatchObject({ filled: true, verdict: "confirmed" });
    expect(await value("input")).toBe("123456");
  }),
);

it.live.each([
  [
    '<input><input autocomplete="one-time-code"><input autocomplete="one-time-code">',
    "ambiguous_code",
  ],
  ['<input type="text">', "missing_code"],
  [
    '<input maxlength="1" autocomplete="one-time-code"><input maxlength="1"><input maxlength="1">',
    "unsupported_split_code",
  ],
] as const)("refuses unsafe code forms: %s", ([markup, code]) =>
  withForm(markup, async ({ fill, protectedFields }) => {
    expect(await fill()).toMatchObject({ filled: false, verdict: "refused", code });
    expect(protectedFields).toHaveLength(0);
  }),
);

it.live("does not set the code when the origin does not match", () =>
  withForm('<input autocomplete="one-time-code">', async ({ fill, protectedFields }) => {
    expect(await fill(true)).toMatchObject({
      filled: false,
      verdict: "refused",
      code: "form_changed",
    });
    expect(protectedFields).toHaveLength(0);
  }),
);
