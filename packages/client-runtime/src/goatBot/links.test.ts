import { describe, expect, it } from "vite-plus/test";

import { splitGoatBotTextLinks } from "./links.ts";

const links = (text: string) =>
  splitGoatBotTextLinks(text).flatMap((part) => (part.kind === "link" ? [part.url] : []));

describe("splitGoatBotTextLinks", () => {
  it("keeps every character and links each address", () => {
    const text = "Stars: 17.8k\nURL:https://github.com/example/opencodex and http://a.dev/x";
    const parts = splitGoatBotTextLinks(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(links(text)).toEqual(["https://github.com/example/opencodex", "http://a.dev/x"]);
    expect(parts[0]).toEqual({ kind: "text", text: "Stars: 17.8k\nURL:" });
  });

  it("leaves sentence punctuation and unopened brackets outside the link", () => {
    expect(links("See https://a.dev/x.")).toEqual(["https://a.dev/x"]);
    expect(links("(see https://a.dev/x)")).toEqual(["https://a.dev/x"]);
    expect(links("https://en.wikipedia.org/wiki/Goat_(film), then")).toEqual([
      "https://en.wikipedia.org/wiki/Goat_(film)",
    ]);
    expect(links("주소는 https://a.dev/x。")).toEqual(["https://a.dev/x"]);
  });

  it("returns plain text when there is no address", () => {
    expect(splitGoatBotTextLinks("no links here")).toEqual([
      { kind: "text", text: "no links here" },
    ]);
  });
});
