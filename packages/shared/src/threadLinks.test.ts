import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@goat/contracts";

import {
  formatThreadLink,
  parseThreadLinkHref,
  relabelThreadLinks,
  resolveThreadLinkRef,
  threadLinkIds,
  threadLinkIdsCacheCharacters,
} from "./threadLinks.ts";

const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});

describe("thread link destinations", () => {
  it("prefers the local literal id, then the local decoded id, over remote matches", () => {
    const source = ref("local", "provider%3A1");
    const decoded = ref("local", "provider:1");
    const remote = ref("remote", "provider%3A1");
    expect(resolveThreadLinkRef(source, [remote, decoded, source])).toEqual(source);
    expect(resolveThreadLinkRef(source, [remote, decoded])).toEqual(decoded);
  });

  it("opens the unique matching chat in another environment", () => {
    const destination = ref("remote");
    expect(resolveThreadLinkRef(ref("local"), [ref("local", "other-chat"), destination])).toEqual(
      destination,
    );
  });

  it("leaves ambiguous or missing destinations unresolved", () => {
    const source = ref("local", "provider%3A1");
    const literal = ref("remote", "provider%3A1");
    const decoded = ref("remote", "provider:1");
    expect(
      resolveThreadLinkRef(source, [literal, ref("other-remote", literal.threadId), decoded]),
    ).toBeNull();
    expect(
      resolveThreadLinkRef(source, [decoded, ref("other-remote", decoded.threadId)]),
    ).toBeNull();
    expect(resolveThreadLinkRef(source, [ref("remote", "other-chat")])).toBeNull();
  });
});

describe("thread links", () => {
  it("preserves a range before a thread link while relabeling", () => {
    expect(
      relabelThreadLinks("Use range [a, b) and [old](goat-thread://v1/t1) next.", () => "New"),
    ).toBe("Use range [a, b) and [New](goat-thread://v1/t1) next.");
  });

  it("preserves unmatched opening brackets before a thread link", () => {
    expect(relabelThreadLinks("[[[ [old](goat-thread://v1/t1)", () => "New")).toBe(
      "[[[ [New](goat-thread://v1/t1)",
    );
  });

  it("leaves escaped thread-link syntax literal while relabeling unescaped links", () => {
    const href = "goat-thread://v1/t1";
    for (const [source, expected] of [
      [`\\[old](${href})`, `\\[old](${href})`],
      [`\\\\[old](${href})`, `\\\\[New](${href})`],
      [`[x](https://example.com/?next=${href})`, `[x](https://example.com/?next=${href})`],
    ] as const) {
      expect(relabelThreadLinks(source, () => "New")).toBe(expected);
    }
  });

  it("leaves a thread link inside another link's address or title as written", () => {
    const href = "goat-thread://v1/t1";
    for (const [source, expected] of [
      [`[Example](<https://example.com/?q=[old](${href})>)`],
      [`[Example](https://example.com "[old](${href})")`],
      [
        `[a](https://example.com/x_(y)) [old](${href})`,
        `[a](https://example.com/x_(y)) [New](${href})`,
      ],
      [
        `[x](<https://example.com/a b> "Title") [old](${href})`,
        `[x](<https://example.com/a b> "Title") [New](${href})`,
      ],
    ] as const) {
      expect(relabelThreadLinks(source, () => "New")).toBe(expected ?? source);
    }
  });
  it("relabels an angle-bracketed thread destination", () => {
    expect(relabelThreadLinks("[old](<goat-thread://v1/t1>)", () => "New")).toBe(
      "[New](goat-thread://v1/t1)",
    );
  });

  it("keeps a thread id with parentheses or a closing paren readable", () => {
    for (const threadId of ["mcp:launch:qa(1)", "mcp:launch:qa)"]) {
      const link = formatThreadLink(threadId, "Original");
      expect(link).toBe(`[Original](<goat-thread://v1/${threadId}>)`);
      expect(parseThreadLinkHref(link.slice(link.indexOf("(<") + 2, -2))).toBe(threadId);
      expect(relabelThreadLinks(link, () => "Renamed")).toBe(
        `[Renamed](<goat-thread://v1/${threadId}>)`,
      );
      // An untitled thread keeps the link as written, so the client can still open it.
      expect(relabelThreadLinks(link, () => undefined)).toBe(link);
    }
  });
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://exa.test")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](goat-thread://v1/thread:project:1) [Literal escape](goat-thread://v1/provider%3A1)",
    );
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", (threadId) => untitled.get(threadId)),
    ).toBe("[Kept](t3-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "[old](t3-thread://v1/t1)",
      "```",
      "After [old](t3-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](goat-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "[old](t3-thread://v1/t1)",
        "```",
        "After [New](goat-thread://v1/t1)",
      ].join("\n"),
    );
    for (const escaped of [
      "\\``[old](goat-thread://v1/t1)`",
      "\\```[old](goat-thread://v1/t1)``",
    ]) {
      expect(threadLinkIds(escaped)).toEqual([]);
    }
  });

  it("ends code where CommonMark does, so a link after it stays live", () => {
    const after = "See [live](goat-thread://v1/t1)";
    const hidden = "[hidden](goat-thread://v1/in-code)";
    for (const markdown of [
      ["```ts", 'const fence = "```";', hidden, "```", after],
      ["> ```ts", '> const fence = "```";', `> ${hidden}`, "> ```", `> ${after}`],
      ["> ```", ` > ${hidden}`, "> ```", after],
      ["- ```bash", "  echo hi", "  ```", "", after],
      ["- > ```md", `  > ${hidden}`, "  > ```", "", after],
      ["1. Run:", "", "    ```bash", '    echo "```"', `    ${hidden}`, "    ```", "", after],
      ["````md", "```", hidden, "````", after],
      ["Use ~~~ to mark it.", after],
      ["```" + hidden + "``` then", after],
      ["Use ```example", hidden, "end``` then", after],
      ["Stray ` tick", "", after, "and `code`"],
      ["Stray ` tick", `# ${after}`, "and `code`"],
      ["Stray ` tick", `- ${after}`, "and `code`"],
      ["Stray ` tick", `> ${after} and \`code\``],
      ["> Stray ` tick", `> > ${after} and \`code\``],
      ["- Stray ` tick", `  > ${after} and \`code\``],
      ["> Use `example", `> ${hidden} end\``, `> ${after}`],
      ["> > Use `example", `> > ${hidden} end\``, `> > ${after}`],
      ["> Use `example", `${hidden} end\``, after],
      ["Use `example", `    > ${hidden} end\``, after],
      ["> Use `example", `>     > ${hidden} end\``, `> ${after}`],
      ["> Intro", "Use `example", `> ${hidden} end\``, `> ${after}`],
      ["> > Intro", "> Use `example", `> > ${hidden} end\``, `> > ${after}`],
      ["1. Stray ` tick", `    > ${after} and \`code\``],
      ["1. Intro", "", "    Stray ` tick", `    > ${after} and \`code\``],
      ["- Intro", "", "Use `example", `    > ${hidden} end\``, after],
      ["Use `example", "```" + hidden + "`", after],
      ["\\\\``" + after + "`"],
    ]) {
      const joined = markdown.join("\n");
      expect(threadLinkIds(joined)).toEqual(["t1"]);
      expect(relabelThreadLinks(joined, () => "New")).toBe(
        joined.replace("[live](goat-thread://v1/t1)", "[New](goat-thread://v1/t1)"),
      );
    }
  });

  it.each(["\r", "\r\n", "\n"])("keeps fenced examples literal with %j line endings", (eol) => {
    for (const fence of ["~~~", "```"]) {
      const text = [fence, "[hidden](goat-thread://v1/hidden)", fence].join(eol);
      const input = `${text}${eol}[after](goat-thread://v1/after)`;
      expect(threadLinkIds(input)).toEqual(["after"]);
      expect(relabelThreadLinks(input, () => "Task")).toBe(
        `${text}${eol}[Task](goat-thread://v1/after)`,
      );
    }
  });

  it("writes the thread id verbatim so the link opens that exact thread", () => {
    const link = formatThreadLink("thread:delegated-task:mcp%3A1", "Fix");
    expect(link).toBe("[Fix](goat-thread://v1/thread:delegated-task:mcp%3A1)");
    expect(parseThreadLinkHref(link.slice(link.indexOf("](") + 2, -1))).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe("[Fix ci build](goat-thread://v1/t1)");
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](goat-thread://v1/t1)");
  });
});

describe("thread link scan cache", () => {
  it("holds a bounded number of characters while a long message streams", () => {
    const message = `See [the fix](goat-thread://v1/fix-1). ${"스트리밍 중인 긴 답변입니다. ".repeat(6_000)}`;
    for (let length = 40; length <= message.length; length += 72) {
      expect(threadLinkIds(message.slice(0, length))).toEqual([ThreadId.make("fix-1")]);
    }
    expect(threadLinkIds(message)).toEqual([ThreadId.make("fix-1")]);
    expect(threadLinkIdsCacheCharacters()).toBeLessThanOrEqual(200_000);
    const short = "[a](goat-thread://v1/a) and [b](goat-thread://v1/b)";
    expect(threadLinkIds(short)).toBe(threadLinkIds(short));
  });

  it("scans a message over the bound once while it stays the latest long one", () => {
    const long = `[big](goat-thread://v1/big) ${"x".repeat(200_001)}`;
    expect(threadLinkIds(long)).toEqual([ThreadId.make("big")]);
    expect(threadLinkIds(long)).toBe(threadLinkIds(long));
    expect(threadLinkIdsCacheCharacters()).toBeLessThanOrEqual(200_000);
  });
});
