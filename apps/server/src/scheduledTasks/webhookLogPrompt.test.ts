import { expect, it } from "vite-plus/test";
import { loggedWebhookPrompt } from "./webhookLogPrompt.ts";

it("does not split an emoji at the prompt limit", () => {
  const prefix = "a".repeat(64 * 1024 - 1);
  expect(loggedWebhookPrompt(`${prefix}😀 tail`)).toBe(prefix);
  expect(loggedWebhookPrompt("plain 😀")).toBe("plain 😀");
});
