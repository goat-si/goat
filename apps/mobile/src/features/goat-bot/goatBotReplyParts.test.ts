import { describe, expect, it } from "vite-plus/test";

import { splitGoatBotReply } from "./goatBotReplyParts";

const table = ["| Step | Tool | Result |", "| --- | :---: | ---: |", "| Read | `read` | 1 file |"];

describe("splitGoatBotReply", () => {
  it("splits an intro, a table and a closing into their own parts", () => {
    const parts = splitGoatBotReply(["Done.", "", ...table, "", "Ask again any time."].join("\n"));
    expect(parts).toEqual([
      { kind: "prose", text: "Done." },
      {
        kind: "table",
        markdown: table.join("\n"),
        header: ["Step", "Tool", "Result"],
        rows: [["Read", "`read`", "1 file"]],
      },
      { kind: "prose", text: "Ask again any time." },
    ]);
  });

  it("leaves a table inside fenced code as prose", () => {
    const text = ["```md", ...table, "```"].join("\n");
    expect(splitGoatBotReply(text)).toEqual([{ kind: "prose", text }]);
  });

  it("keeps an escaped pipe inside its cell", () => {
    const parts = splitGoatBotReply(["| A | B |", "| - | - |", "| x \\| y | z |"].join("\n"));
    expect(parts).toMatchObject([{ kind: "table", rows: [["x | y", "z"]] }]);
  });

  it("reads a header without a delimiter row, or with other column counts, as prose", () => {
    const loose = ["| A | B |", "| x | y |"].join("\n");
    const uneven = ["| A | B |", "| --- | --- | --- |", "| x | y |"].join("\n");
    expect(splitGoatBotReply(loose)).toEqual([{ kind: "prose", text: loose }]);
    expect(splitGoatBotReply(uneven)).toEqual([{ kind: "prose", text: uneven }]);
  });

  it("returns one prose part for text without a table", () => {
    expect(splitGoatBotReply("Just words.")).toEqual([{ kind: "prose", text: "Just words." }]);
  });
});
