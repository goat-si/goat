import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runBrowserAccessScenario } from "./test/ProviderSessionManagerBrowserAccess.testkit.ts";

it.effect("advertises device access only while the device hub is enabled", () =>
  Effect.gen(function* () {
    for (const deviceOverride of [undefined, true]) {
      const options = {
        enableAgentBrowserAccess: false,
        projectOverride: false,
        enableAgentDeviceAccess: true,
        deviceOverride,
      };
      const off = yield* runBrowserAccessScenario({ ...options, enableDeviceSupport: false });
      assert.isFalse(off?.capabilities?.has("device"));
      const on = yield* runBrowserAccessScenario({ ...options, enableDeviceSupport: true });
      assert.isTrue(on?.capabilities?.has("device"));
    }
  }),
);
