import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { hasNativeGoals } from "./providerTurnStartHelpers.ts";

// Only the driver and the negotiated capabilities decide; the rest of the session is unused.
const session = (driver: string, supportsNativeGoals: boolean) =>
  ({
    driver: ProviderDriverKind.make(driver),
    providerSession: {
      capabilities: {
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsNativeGoals },
      },
    },
  }) as unknown as Parameters<typeof hasNativeGoals>[0];

it.each(["antigravity", "opencode"])(
  "sends /goal natively to a %s session only when it reports native goals",
  (driver) => {
    assert.isTrue(hasNativeGoals(session(driver, true)));
    assert.isFalse(hasNativeGoals(session(driver, false)));
  },
);
