import { expect, it } from "vite-plus/test";
import { createClaudeReportedContext } from "./ClaudeReportedContext.ts";

it("uses a valid reported window only for the matching model and instance", () => {
  const first = createClaudeReportedContext();
  const second = createClaudeReportedContext();
  expect(first.record({ gateway: { contextWindow: 1_048_576 }, bad: { contextWindow: -1 } })).toBe(
    true,
  );
  expect(first.get("gateway")).toBe(1_048_576);
  expect(first.get("bad")).toBeUndefined();
  expect(second.get("gateway")).toBeUndefined();
  expect(first.record({ gateway: { contextWindow: 1_048_576 } })).toBe(false);
});
