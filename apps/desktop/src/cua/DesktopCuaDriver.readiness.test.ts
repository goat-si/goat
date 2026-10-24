import { assert, describe, it } from "@effect/vitest";
import { computerUseReady } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

import {
  fixture,
  healthyTools,
  HELPER_ID,
  HELPER_PID,
  helperTools,
  toolResult,
} from "./DesktopCuaDriver.testkit.ts";

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver readiness after a passing check", () => {
  it.effect.each(["darwin", "win32"] as const)(
    "drops an earlier check's proof when a later start cannot use the helper on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform,
            helper: { granted: true },
            tools:
              platform === "win32"
                ? {
                    ...healthyTools(),
                    check_permissions: toolResult({ elevated: false, uia: true }),
                  }
                : helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
          });
          assert.isTrue((yield* test.verify).verified);
          const proven = test.readiness.at(-1)?.readiness;
          assert.isTrue(proven ? computerUseReady(proven) : false);

          // The helper's identity no longer matches when the next agent asks for it.
          yield* test.answerAsHelper({ granted: true, fails: new Error("bundle_mismatch") });
          yield* test.request("mismatch");
          assert.equal((yield* test.next).status, "unavailable");
          const after = test.readiness.at(-1)?.readiness;
          assert.equal(after?.helper, "unauthenticated");
          assert.equal(after?.capture, "pending");
          assert.isFalse(after ? computerUseReady(after) : true);
        }),
      ),
  );
});
