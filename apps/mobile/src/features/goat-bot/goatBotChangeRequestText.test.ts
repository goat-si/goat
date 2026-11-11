import { splitGoatBotTextLinks } from "@goat/client-runtime/goatBot";
import { describe, expect, it } from "vite-plus/test";

import {
  goatBotChangeRequestMarkdown,
  goatBotChangeRequestParts,
} from "./goatBotChangeRequestText";

const pr = (n: number, repo = "goat-si/goat") => `https://github.com/${repo}/pull/${n}`;
const REF_8 = /\[#8\]\(https:\/\/github\.com\/goat-si\/goat\/(?:issues|pull)\/8\)/u;

describe("goatBotChangeRequestMarkdown", () => {
  it("reads a pull request address as its number, and links a bare reference in that repository", () => {
    const out = goatBotChangeRequestMarkdown(`Merged **${pr(7)}**; #8 is next.`);
    expect(out).toContain(`**[#7](${pr(7)})**`);
    expect(out).toMatch(REF_8);
  });

  it("names the repository when a reply links more than one, and links no bare number then", () => {
    const out = goatBotChangeRequestMarkdown(`${pr(7)} and ${pr(9, "other/repo")}; #8 too`);
    expect(out).toContain(`[goat-si/goat#7](${pr(7)})`);
    expect(out).toContain(`[other/repo#9](${pr(9, "other/repo")})`);
    expect(out).toContain("; #8 too");
  });

  it("keeps a link the bot named, addresses in code, and look-alike hosts as written", () => {
    const named = `See [the fix](${pr(7)}).`;
    expect(goatBotChangeRequestMarkdown(named)).toBe(named);
    for (const text of [
      `Run \`${pr(7)}\` #8`,
      ["```", pr(7), "```", "#8"].join("\n"),
      "https://github.com.evil.example/goat-si/goat/pull/7",
    ]) {
      expect(goatBotChangeRequestMarkdown(text)).toBe(text);
    }
  });
});

describe("goatBotChangeRequestParts", () => {
  it("shortens plain-text pull request addresses and links bare references beside them", () => {
    const parts = goatBotChangeRequestParts(splitGoatBotTextLinks(`Merged ${pr(7)} and #8`));
    expect(parts.filter((part) => part.kind === "link").map((part) => part.text)).toEqual([
      "#7",
      "#8",
    ]);
    expect(parts.map((part) => part.text).join("")).toBe("Merged #7 and #8");
  });
});
