import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import { fillCard } from "./ServerBrowserCardFill.ts";

const card = {
  number: "4242424242424242",
  expiryMonth: "01",
  expiryYear: "2029",
  cvc: "003",
  name: "Example Name",
};

const withForm = <A>(
  markup: string,
  run: (fixture: {
    fill: () => ReturnType<typeof fillCard>;
    read: (selector: string) => Promise<string>;
    masked: string[];
    protectedFields: Array<{ objectId: string; value: string }>;
  }) => Promise<A>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (instance) => Effect.promise(() => instance.close()),
      );
      const page = yield* Effect.promise(async () => {
        const context = await browser.newContext();
        await context.route("**/*", (route) =>
          route.fulfill({ contentType: "text/html", body: `<form>${markup}</form>` }),
        );
        const page = await context.newPage();
        await page.goto("https://card.test/");
        await page.locator("form input, form select").first().focus();
        return page;
      });
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const tree = yield* Effect.promise(() => cdp.send("Page.getFrameTree"));
      const world = yield* Effect.promise(() =>
        cdp.send("Page.createIsolatedWorld", {
          frameId: tree.frameTree.frame.id,
          worldName: "card-test",
        }),
      );
      const masked: string[] = [];
      const protectedFields: Array<{ objectId: string; value: string }> = [];
      return yield* Effect.promise(() =>
        run({
          fill: () =>
            fillCard({
              send: async (method, params, onDispatch) => {
                onDispatch?.();
                return Reflect.apply(cdp.send, cdp, [method, params]);
              },
              contextId: world.executionContextId,
              origin: "https://card.test",
              card,
              register: (value) => masked.push(value),
              protect: (field) => {
                protectedFields.push(field);
                return () => {
                  const at = protectedFields.indexOf(field);
                  if (at >= 0) protectedFields.splice(at, 1);
                };
              },
            }),
          read: (selector) => page.locator(selector).inputValue(),
          masked,
          protectedFields,
        }),
      );
    }),
  );

it.live("fills section-prefixed card fields and single expiry without exposing their values", () =>
  withForm(
    '<input id="number" autocomplete="section-billing cc-number"><input id="expiry" autocomplete="section-billing cc-exp"><input id="cvc" autocomplete="section-billing cc-csc"><input id="name" autocomplete="section-billing cc-name">',
    async ({ fill, read, masked, protectedFields }) => {
      const result = await fill();
      expect(result).toMatchObject({
        verdict: "confirmed",
        numberFilled: true,
        cvcFilled: true,
        expiryFilled: true,
        nameFilled: true,
      });
      expect(await read("#number")).toBe(card.number);
      expect(await read("#expiry")).toBe("01/2029");
      expect(await read("#cvc")).toBe(card.cvc);
      expect(await read("#name")).toBe(card.name);
      expect(masked).toEqual(expect.arrayContaining([card.number, card.cvc, card.name]));
      expect(protectedFields).toHaveLength(4);
      expect(JSON.stringify(result)).not.toContain(card.number);
      expect(JSON.stringify(result)).not.toContain(card.cvc);
    },
  ),
);

it.live("matches expiry select options by value or text", () =>
  withForm(
    '<input id="number" autocomplete="cc-number"><select id="month" autocomplete="cc-exp-month"><option value="jan">01</option></select><select id="year" autocomplete="cc-exp-year"><option value="29">2029</option></select><input id="cvc" autocomplete="cc-csc">',
    async ({ fill, read }) => {
      expect(await fill()).toMatchObject({ verdict: "confirmed", expiryFilled: true });
      expect(await read("#month")).toBe("jan");
      expect(await read("#year")).toBe("29");
    },
  ),
);

it.live("reports the exact expiry fields set before an unmatched option stops delivery", () =>
  withForm(
    '<input id="number" autocomplete="cc-number"><select id="month" autocomplete="cc-exp-month"><option value="01">January</option></select><select id="year" autocomplete="cc-exp-year"><option value="2030">2030</option></select><input id="cvc" autocomplete="cc-csc">',
    async ({ fill, read }) => {
      expect(await fill()).toMatchObject({
        verdict: "unverifiable",
        code: "no_option_year",
        numberFilled: true,
        expiryMonthFilled: true,
        expiryYearFilled: false,
        cvcFilled: false,
      });
      expect(await read("#cvc")).toBe("");
    },
  ),
);

it.live.each([
  ['<input autocomplete="cc-number">', "missing_cvc"],
  ['<input autocomplete="cc-csc">', "missing_number"],
  [
    '<input autocomplete="cc-number"><input autocomplete="cc-number"><input autocomplete="cc-csc">',
    "ambiguous_number",
  ],
  [
    '<input autocomplete="cc-number"><input autocomplete="cc-csc"><input autocomplete="cc-given-name"><input autocomplete="cc-family-name">',
    "unsupported_split_name",
  ],
] as const)("refuses unsafe forms before input: %s", ([markup, code]) =>
  withForm(markup, async ({ fill, protectedFields }) => {
    expect(await fill()).toMatchObject({ verdict: "refused", code });
    expect(protectedFields).toHaveLength(0);
  }),
);
