import { expect, it } from "vite-plus/test";
import { buildGoatBotQuote, parseGoatBotQuote } from "./quote.ts";

it("builds and parses multiline replies, limiting the quoted source", () => {
  const source = `first\n${"x".repeat(250)}`;
  const result = buildGoatBotQuote(source, "answer");
  expect(result).toBe(`> first\n> ${"x".repeat(194)}\n\nanswer`);
  expect(parseGoatBotQuote(result)).toEqual({ quote: source.slice(0, 200), text: "answer" });
});
it("keeps plain text and an unseparated typed quote intact", () => {
  expect(parseGoatBotQuote("hello")).toEqual({ text: "hello" });
  expect(parseGoatBotQuote("> my own words")).toEqual({ text: "> my own words" });
});
