import { it as effectIt } from "@effect/vitest";
import { ScheduledTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
        byPerson: true,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

for (const [author, input] of [
  ["an agent's", { createdBy: "agent" }],
  // The schedule's author was a person, but an agent may have edited its prompt since.
  ["a scheduled run's", { scheduledTaskId: ScheduledTaskId.make("schedule:edited") }],
] as const) {
  effectIt.effect(`fails ${author} /logout and leaves the provider signed in`, () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "/logout",
        previousNativeSession: true,
        ...input,
      });

      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ byPerson: false }),
      );
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("failed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          title: "Provider sign-out failed",
          failure: { message: "Only a person can sign out of a provider." },
        },
      ]);
      expect(harness.open).not.toHaveBeenCalled();
    }),
  );
}
