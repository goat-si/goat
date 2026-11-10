import { describe, expect, it } from "vite-plus/test";

import { goatBotWithoutThreadLinks } from "./goatBotChatMarkdown";

describe("goatBotWithoutThreadLinks", () => {
  it("keeps a thread link's words and drops the link", () => {
    expect(goatBotWithoutThreadLinks("Started [Fix the build](goat-thread://v1/thread-1).")).toBe(
      "Started Fix the build.",
    );
    expect(goatBotWithoutThreadLinks("See [it](<goat-thread://v1/thread-1>)")).toBe("See it");
  });

  it("drops links written with the older thread protocol too", () => {
    expect(goatBotWithoutThreadLinks("[old](t3-thread://v1/thread-1)")).toBe("old");
  });

  it("keeps web, pull request and other links", () => {
    const text = "[PR #42](https://github.com/o/r/pull/42) and [docs](https://example.com)";
    expect(goatBotWithoutThreadLinks(`${text} [t](goat-thread://v1/x)`)).toBe(`${text} t`);
  });

  it("leaves code spans and fenced blocks exactly as written", () => {
    const span = "Write `[t](goat-thread://v1/x)` to link. [t](goat-thread://v1/x)";
    expect(goatBotWithoutThreadLinks(span)).toBe("Write `[t](goat-thread://v1/x)` to link. t");
    const fenced = "```md\n[t](goat-thread://v1/x)\n```\n[t](goat-thread://v1/x)";
    expect(goatBotWithoutThreadLinks(fenced)).toBe("```md\n[t](goat-thread://v1/x)\n```\nt");
  });

  it("keeps a label with brackets in it whole", () => {
    expect(goatBotWithoutThreadLinks("[Fix [web] tabs](goat-thread://v1/x)")).toBe(
      "Fix [web] tabs",
    );
  });
});
