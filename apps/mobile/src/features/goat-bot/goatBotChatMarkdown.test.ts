import { ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { goatBotWithoutThreadLinks } from "./goatBotChatMarkdown";

// Threads the bot's home lists, which it opens instead of the conversation.
const listed = new Set(["thread-1", "x", "a(b)", "a b"].map((id) => ThreadId.make(id)));
const strip = (markdown: string) => goatBotWithoutThreadLinks(markdown, listed);

describe("goatBotWithoutThreadLinks", () => {
  it("keeps a listed thread link's words and drops the link", () => {
    expect(strip("Started [Fix the build](goat-thread://v1/thread-1).")).toBe(
      "Started Fix the build.",
    );
    expect(strip("See [it](<goat-thread://v1/thread-1>)")).toBe("See it");
  });

  it("keeps a link to a thread the home cannot open", () => {
    const text = "See [older work](goat-thread://v1/aged-out) and [x](goat-thread://v1/x).";
    expect(strip(text)).toBe("See [older work](goat-thread://v1/aged-out) and x.");
    expect(goatBotWithoutThreadLinks(text, new Set())).toBe(text);
  });

  it("drops links written with the older thread protocol too", () => {
    expect(strip("[old](t3-thread://v1/thread-1)")).toBe("old");
  });

  it("keeps web, pull request and other links", () => {
    const text = "[PR #42](https://github.com/o/r/pull/42) and [docs](https://example.com)";
    expect(strip(`${text} [t](goat-thread://v1/x)`)).toBe(`${text} t`);
  });

  it("reads the whole destination and title, parentheses included", () => {
    expect(strip("Open [work](<goat-thread://v1/a(b)>) now.")).toBe("Open work now.");
    expect(strip('Open [work](goat-thread://v1/x "the (fix) thread") now.')).toBe("Open work now.");
    expect(strip("Open [work](<goat-thread://v1/a b> 'title') now.")).toBe("Open work now.");
    expect(strip("[w](https://e.com/a_(b)) [t](goat-thread://v1/x)")).toBe(
      "[w](https://e.com/a_(b)) t",
    );
  });

  it("leaves code spans and fenced blocks exactly as written", () => {
    const span = "Write `[t](goat-thread://v1/x)` to link. [t](goat-thread://v1/x)";
    expect(strip(span)).toBe("Write `[t](goat-thread://v1/x)` to link. t");
    const fenced = "```md\n[t](goat-thread://v1/x)\n```\n[t](goat-thread://v1/x)";
    expect(strip(fenced)).toBe("```md\n[t](goat-thread://v1/x)\n```\nt");
  });

  it("leaves a code span that runs over several lines exactly as written", () => {
    const span = "Example: `one\n[work](goat-thread://v1/x)\ntwo` and [work](goat-thread://v1/x).";
    expect(strip(span)).toBe("Example: `one\n[work](goat-thread://v1/x)\ntwo` and work.");
  });

  it("keeps a label with brackets in it whole", () => {
    expect(strip("[Fix [web] tabs](goat-thread://v1/x)")).toBe("Fix [web] tabs");
  });
});
