import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ThreadSearch from "./ThreadSearch.ts";

it.effect("starts snippets a few words before the match so one line shows it", () =>
  Effect.sync(() => {
    const snippet = (text: string, word: string) =>
      ThreadSearch.buildSearchSnippet(text, text.indexOf(word));
    const long = `${"lead ".repeat(60)}the NEEDLE sits here ${"tail ".repeat(60)}`;
    const cut = snippet(long, "NEEDLE");
    assert.isAtMost(cut.length, 240);
    assert.match(cut, /^…(lead ){2,4}the NEEDLE sits here/);
    assert.isTrue(cut.endsWith("…"));
    // Whitespace collapses only in the shown part, so the offset still lands.
    assert.match(snippet(`${"word\n\n  ".repeat(60)}un café`, "café"), /un café$/);
    // A cut never splits an emoji's surrogate pair.
    assert.notMatch(
      snippet(`x${"🚀".repeat(200)}needle`, "needle"),
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
    assert.equal(snippet(`needle${" ".repeat(473)}🚀 tail`, "needle"), "needle 🚀…");
    // Emphasis and code marks go, as the thread shows the text.
    assert.equal(
      ThreadSearch.buildSearchSnippet("Use **bold** and `code` here", 0),
      "Use bold and code here",
    );
    assert.equal(ThreadSearch.buildSearchSnippet("Call __init__ first", 0), "Call __init__ first");
    // Short text still moves a late match into view.
    assert.equal(snippet(`${"word ".repeat(20)}needle`, "needle"), "…word word word word needle");
  }),
);
