import { expect, it } from "vite-plus/test";
import { buildGoatBotQuote, parseGoatBotQuote } from "./quote.ts";

it("puts the person's words first and the quoted source after, limited and multi-line", () => {
  const source = `first\n${"x".repeat(250)}`;
  const result = buildGoatBotQuote(source, "answer");
  expect(result).toBe(`answer\n\n> first\n> ${"x".repeat(194)}`);
  expect(parseGoatBotQuote(result)).toEqual({ text: "answer", quote: source.slice(0, 200) });
});

it("keeps plain text, a typed quote with nothing before it, and a quote mid-message intact", () => {
  expect(parseGoatBotQuote("hello")).toEqual({ text: "hello" });
  expect(parseGoatBotQuote("> my own words")).toEqual({ text: "> my own words" });
  expect(parseGoatBotQuote("> cited\n\nmy point")).toEqual({ text: "> cited\n\nmy point" });
});
