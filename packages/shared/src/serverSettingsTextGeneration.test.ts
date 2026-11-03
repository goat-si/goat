import { expect, it } from "vite-plus/test";
import { fallbackTextGenerationModelSelection } from "./serverSettings.ts";

it("uses Big Pickle when only OpenCode is enabled", () => {
  expect(
    fallbackTextGenerationModelSelection({}, (instanceId) => instanceId === "opencode"),
  ).toEqual({ instanceId: "opencode", model: "opencode/big-pickle" });
});
