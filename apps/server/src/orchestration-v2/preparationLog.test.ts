import { describe, expect, it } from "@effect/vitest";

import { appendPreparationLine, redactLogLine, renderPreparationLog } from "./preparationLog.ts";

const build = (lines: ReadonlyArray<string>) => lines.reduce(appendPreparationLine, []);

describe("preparationLog", () => {
  it.each([
    [
      "fatal: unable to access 'https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/'",
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
    ],
    ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "token ***"],
    ["Authorization: Bearer abcdefghijklmnop.qrstuv", "Authorization: Bearer ***"],
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv", "export OPENAI_API_KEY=***"],
    ["password=hunter2hunter2 user=me", "password=*** user=me"],
    ["Receiving objects: 100% (2000/2000), done.", "Receiving objects: 100% (2000/2000), done."],
  ])("redacts %s", (line, expected) => {
    expect(redactLogLine(line)).toBe(expected);
  });

  it("keeps only the latest progress line of each step", () => {
    const log = build([
      "Fetching dev from its remote.",
      "remote: Enumerating objects: 10% (1/10)",
      "remote: Enumerating objects: 100% (10/10), done.",
      "Receiving objects:   3% (60/2000)",
      "Receiving objects:  45% (900/2000)",
      "",
      "fatal: early EOF",
    ]);
    expect(log).toEqual([
      "Fetching dev from its remote.",
      "remote: Enumerating objects: 100% (10/10), done.",
      "Receiving objects:  45% (900/2000)",
      "fatal: early EOF",
    ]);
  });

  it("keeps the last lines and cuts the text from the front", () => {
    const log = build(Array.from({ length: 100 }, (_, index) => `${index} ${"x".repeat(400)}`));
    expect(log).toHaveLength(40);
    expect(log[0]?.startsWith("60 ")).toBe(true);
    const text = renderPreparationLog(log) ?? "";
    expect(text.length).toBeLessThanOrEqual(6_000);
    expect(text.startsWith("…\n")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text).toContain("99 ");
    expect(renderPreparationLog([])).toBeNull();
  });
});
