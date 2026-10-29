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

effectIt.effect(
  "asks the provider to sign out for a scheduled run's /logout only as not written by a person",
  () =>
    Effect.gen(function* () {
      // The schedule's author was a person, but an agent may have edited its prompt since.
      const harness = makeLocalCommandHarness({
        text: "/logout",
        previousNativeSession: true,
        scheduledTaskId: ScheduledTaskId.make("schedule:edited"),
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
