import { expect, it } from "@effect/vitest";
import { makeCwdScanner } from "./AgentSessionTranscriptCwd.ts";

it("ignores incomplete Pi headers and unrelated records during discovery", () => {
  const scanner = makeCwdScanner("pi", { recordsRemaining: 10, truncated: false }, 4096, 10);
  const encode = (text: string) => new TextEncoder().encode(text);
  expect(
    scanner.scanChunk(
      encode('{"type":"message","cwd":"/wrong"}\n{"type":"session","cwd":"/right"'),
    ),
  ).toBeUndefined();
  expect(scanner.scanChunk(encode("}\n"))).toBe("/right");
});
