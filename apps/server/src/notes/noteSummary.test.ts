import { describe, expect, it } from "@effect/vitest";
import { bodySummary } from "./noteSummary.ts";

describe("note previews", () => {
  it("show embedded files and links by name", () => {
    const body = [
      "# Video ideas",
      "",
      "![diagram](/.attachments/0916c072579efcd0.png)",
      "",
      '[agenda.txt](</.attachments/be7426874743022a.txt> "Agenda") and [docs](https://example.com)',
    ].join("\n");
    expect(bodySummary(body, "fallback").preview).toBe("diagram agenda.txt and docs");
  });
});
