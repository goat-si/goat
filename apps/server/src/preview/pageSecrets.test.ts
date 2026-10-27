import type { Page } from "playwright-core";
import { expect, it } from "vite-plus/test";

import { rememberSecret, tabCookies } from "./pageSecrets.ts";

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
