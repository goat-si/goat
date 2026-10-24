import { describe, expect, it } from "@effect/vitest";

import { appendPreparationLine, renderPreparationLog } from "./preparationLog.ts";

const build = (lines: ReadonlyArray<string>) => lines.reduce(appendPreparationLine, []);

describe("preparationLog", () => {
  it("redacts each line on the way in", () => {
    const log = build([
      "Cloning https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git",
    ]);
    expect(log).toEqual(["Cloning https://***@github.com/o/r.git"]);
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
