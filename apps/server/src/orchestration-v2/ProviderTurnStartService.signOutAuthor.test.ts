import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect(
  "asks the provider to sign out for an agent's /logout only as not written by a person",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "/logout",
        previousNativeSession: true,
        createdBy: "agent",
      });

      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
        byPerson: false,
      });
    }),
);
