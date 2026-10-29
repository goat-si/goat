import type { Page } from "playwright-core";
import { expect, it } from "vite-plus/test";

import {
  dottedPattern,
  maskSecrets,
  maskTree,
  protectedNumbers,
  redactValue,
  rememberSecret,
  tabCookies,
} from "./pageSecrets.ts";

it("keeps a filled secret among the tab's values however many cookies the context churns", async () => {
  const held = Array.from({ length: 10_001 }, (_, index) => ({
    name: "rotating",
    value: `rotated-value-${index}`,
  }));
  const context = { cookies: async () => held };
  const page = { url: () => "about:blank", context: () => context } as unknown as Page;
  rememberSecret(page, "alpha-MiddleCookie123-omega");
  const values = await tabCookies(page);
  expect(values).toContainEqual({ name: "", value: "alpha-MiddleCookie123-omega", filled: true });
});

it("masks a filled echo whole when another password field's value lies inside it", () => {
  const filled = [{ name: "", value: "alpha-MiddlePassword123-omega", filled: true }];
  const dotted = /MiddlePassword123/gu;
  expect(maskSecrets(dotted, filled)("echo alpha-MiddlePassword123-omega")).toBe("echo [redacted]");
  expect(maskTree("- paragraph: alpha-MiddlePassword123-omega", dotted, filled)).toBe(
    "- paragraph: [redacted]",
  );
  // A field value on its own still shows as dots.
  expect(maskSecrets(dotted, [])("pw MiddlePassword123")).toBe("pw ••••••••");
});

it("a number an evaluation reads from a masked field comes back masked, however the page converted it", () => {
  const values = ["123456", "010-1234-5678", "4111111111111111111", "0000"];
  const mask = maskSecrets(dottedPattern(values), []);
  const numbers = protectedNumbers(values);
  expect(
    redactValue(
      // The card number as Number() rounds it, and the phone without its leading zero.
      { code: 123456, phone: 1012345678, card: Number("4111111111111111111"), count: 3 },
      mask,
      numbers,
    ),
  ).toEqual({ code: "••••••••", phone: "••••••••", card: "••••••••", count: 3 });
  expect(redactValue(BigInt("4111111111111111111"), mask, numbers)).toBe("••••••••");
});

it("a short security code, or a code turned back into a string, comes back masked from an evaluation", () => {
  const values = ["123", "012345"];
  const mask = maskSecrets(dottedPattern(values), []);
  const numbers = protectedNumbers(values);
  expect(redactValue(123, mask, numbers)).toBe("••••••••");
  expect(redactValue(String(Number("012345")), mask, numbers)).toBe("••••••••");
  expect(redactValue({ text: "code 12345, total 99" }, mask, numbers)).toEqual({
    text: "code ••••••••, total 99",
  });
  // Page text keeps its own mask: the code's numeric forms do not spread to other text.
  expect(mask("Amount: 12345")).toBe("Amount: 12345");
});

it("a code written in exponent form is masked, and keys that mask alike both stay", () => {
  const values = ["4111111111111111111111", "123"];
  const mask = maskSecrets(dottedPattern(values), []);
  const numbers = protectedNumbers(values);
  expect(redactValue(String(Number("4111111111111111111111")), mask, numbers)).toBe("••••••••");
  expect(redactValue({ item123: "a", item0123: "b" }, mask, numbers)).toEqual({
    "item••••••••": "a",
    "item•••••••• (2)": "b",
  });
});

it("a masked code made of zeros does not mask other zeros in page text", () => {
  const mask = maskSecrets(dottedPattern(["0000", "010-1234-5678"]), []);
  expect(mask("Amount: 0; rows: 0; call 1012345678")).toBe("Amount: 0; rows: 0; call 1012345678");
  expect(mask("code 0000")).toBe("code ••••••••");
});
