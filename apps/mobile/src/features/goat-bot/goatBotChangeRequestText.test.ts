import { splitGoatBotTextLinks } from "@goat/client-runtime/goatBot";
import { describe, expect, it } from "vite-plus/test";

import {
  goatBotChangeRequestContext,
  goatBotChangeRequestLinks,
  goatBotChangeRequestParts,
} from "./goatBotChangeRequestText";

const pr = (n: number, repo = "goat-si/goat") => `https://github.com/${repo}/pull/${n}`;
const REF_8 = /\[#8\]\(https:\/\/github\.com\/goat-si\/goat\/(?:issues|pull)\/8\)/u;

describe("goatBotChangeRequestLinks", () => {
  const links = (text: string, context?: Parameters<typeof goatBotChangeRequestLinks>[1]) =>
    goatBotChangeRequestLinks(text, context);

  it("labels a bare pull request address with its number, and links a bare reference in that repository", () => {
    const out = links(`Merged **${pr(7)}**; #8 is next.`);
    expect(out.markdown).toContain(`**<${pr(7)}>**`);
    expect(out.labels.get(pr(7))).toBe("#7");
    expect(out.markdown).toMatch(REF_8);
  });

  it("names the repository when a reply links more than one, and links no bare number then", () => {
    const out = links(`${pr(7)} and ${pr(9, "other/repo")}; #8 too`);
    expect(out.labels.get(pr(7))).toBe("goat-si/goat#7");
    expect(out.labels.get(pr(9, "other/repo"))).toBe("other/repo#9");
    expect(out.markdown).toContain("; #8 too");
  });

  it("writes the label in where the same address also sits under the bot's words", () => {
    const out = links(`${pr(7)} is [the fix](${pr(7)}).`);
    expect(out.markdown).toBe(`[#7](${pr(7)}) is [the fix](${pr(7)}).`);
    expect(out.labels.size).toBe(0);
  });

  it("keeps a link the bot named, addresses in code or markup, and look-alike hosts as written", () => {
    const named = `See [the fix](${pr(7)}).`;
    expect(links(named).markdown).toBe(named);
    for (const text of [
      `Run \`${pr(7)}\` #8`,
      ["```", pr(7), "```", "#8"].join("\n"),
      "https://github.com.evil.example/goat-si/goat/pull/7",
      `Merged <span>${pr(7)}</span>.`,
    ]) {
      expect(links(text).markdown).toBe(text);
      expect(links(text).labels.size).toBe(0);
    }
  });

  it("leaves an address inside HTML code as written and does not take its repository", () => {
    const text = `See <code>${pr(9, "other/repo")}</code> and ${pr(7)}; #8 is next.`;
    const out = links(text);
    expect(out.markdown).toContain(`<code>${pr(9, "other/repo")}</code>`);
    expect(out.labels.get(pr(7))).toBe("#7");
    expect(out.markdown).toMatch(REF_8);
  });

  it("takes the repository from the whole reply, so one card's links follow the others", () => {
    const reply = `Fixed in ${pr(7)}; #8 is next.\n\n| PR |\n| - |\n| ${pr(9, "other/repo")} |`;
    const context = goatBotChangeRequestContext(reply);
    expect(context).toBeNull();
    const prose = links(`Fixed in ${pr(7)}; #8 is next.`, context);
    expect(prose.labels.get(pr(7))).toBe("goat-si/goat#7");
    expect(prose.markdown).not.toMatch(REF_8);
    const single = goatBotChangeRequestContext(`${pr(7)}\n\n| PR |\n| - |\n| #8 |`);
    expect(links("| PR |\n| - |\n| #8 |", single).markdown).toMatch(REF_8);
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

  it("leaves addresses and references inside backticks or fences as written", () => {
    const shown = (text: string) => {
      const parts = goatBotChangeRequestParts(splitGoatBotTextLinks(text), text);
      return {
        text: parts.map((part) => part.text).join(""),
        links: parts.filter((part) => part.kind === "link").map((part) => part.text),
      };
    };
    const inline = shown(`Run \`${pr(7)} #8\` after ${pr(7)}`);
    expect(inline.text).toBe(`Run \`${pr(7)} #8\` after #7`);
    expect(inline.links).toEqual([pr(7), "#7"]);
    const fenced = shown(
      ["```", `${pr(9, "other/repo")} #8`, "```", `Done in ${pr(7)}`].join("\n"),
    );
    expect(fenced.text).toContain(`${pr(9, "other/repo")} #8`);
    expect(fenced.links.at(-1)).toBe("#7");
  });
});
