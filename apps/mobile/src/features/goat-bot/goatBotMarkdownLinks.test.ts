import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { goatBotMarkdownLinkTarget } from "./goatBotMarkdownLinks";

const home = EnvironmentId.make("bot-home");

describe("goatBotMarkdownLinkTarget", () => {
  it("opens web pages and threads of the shown history", () => {
    expect(goatBotMarkdownLinkTarget("https://a.dev/x", home, [])).toEqual({
      kind: "external",
      href: "https://a.dev/x",
    });
    expect(goatBotMarkdownLinkTarget("goat-thread://v1/worker", home, [])).toEqual({
      kind: "thread",
      thread: { environmentId: home, threadId: ThreadId.make("worker") },
    });
  });

  it.each([
    "intent://example/#Intent;scheme=test;end",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "C:/repo/secret.txt",
    "mailto:someone@example.com",
    "custom-app://open",
  ])("opens nothing for %j", (href) => {
    expect(goatBotMarkdownLinkTarget(href, home, [])).toBeNull();
  });

  it("opens no thread when the shown history has no environment", () => {
    expect(goatBotMarkdownLinkTarget("goat-thread://v1/worker", null, [])).toBeNull();
  });
});
