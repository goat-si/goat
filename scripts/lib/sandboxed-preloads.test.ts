import { assert, it } from "@effect/vitest";

import { sandboxedPreloadSyntaxError } from "./sandboxed-preloads.ts";

it("refuses a preload that Electron's sandbox wrapper cannot parse", () => {
  // Effect's scheduler declared this at the top level of the 0.1.1 nightly preload.
  const effectScheduler = "const setImmediate = (f) => f();\nsetImmediate(() => {});";
  assert.include(sandboxedPreloadSyntaxError(effectScheduler) ?? "", "setImmediate");
  assert.strictEqual(
    sandboxedPreloadSyntaxError("(() => {\n" + effectScheduler + "\n})();"),
    undefined,
  );
});
