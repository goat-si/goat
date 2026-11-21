import { expect, it } from "vite-plus/test";
import { parseCliArgs } from "./cliArgs.ts";

it("allows a specified value flag to consume text starting with two hyphens", () => {
  expect(
    parseCliArgs(["--append-system-prompt", "-- text", "--chrome"], {
      valueFlags: ["append-system-prompt"],
    }),
  ).toEqual({
    flags: { "append-system-prompt": "-- text", chrome: null },
    positionals: [],
  });
});
