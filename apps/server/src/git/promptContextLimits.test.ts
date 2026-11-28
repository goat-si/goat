import { expect, it } from "vite-plus/test";
import { limitCommandOutput } from "./promptContextLimits.ts";
import type { OrchestrationV2TurnItem } from "@goat/contracts";

it("preserves a complete character at the start of truncated command output", () => {
  const item = {
    type: "command_execution",
    output: "x😀" + "a".repeat(1999),
  } as OrchestrationV2TurnItem;
  expect(limitCommandOutput(item)).toMatchObject({ output: "[truncated]\n" + "a".repeat(1999) });
});
