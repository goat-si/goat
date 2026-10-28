import type { Page } from "playwright-core";
import { expect, it } from "vite-plus/test";

import {
  dottedPattern,
  maskSecrets,
  maskTree,
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

it("a number an evaluation reads from a masked field comes back masked", () => {
  const mask = maskSecrets(dottedPattern(["123456", "010-1234-5678"]), []);
  expect(redactValue(123456, mask)).toBe("••••••••");
  expect(redactValue({ code: 123456, phone: 1012345678, count: 3 }, mask)).toEqual({
    code: "••••••••",
    phone: "••••••••",
    count: 3,
  });
  expect(redactValue(7, mask)).toBe(7);
});
