import type { OrchestrationV2ThreadShell } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { OrchestrationEffectV2 } from "../EffectOutbox.ts";
import * as ResourceCleanupService from "../ResourceCleanupService.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import { OrchestrationEffectExecutionError } from "./EffectExecution.ts";

/** A thread back in use since its settle or archive keeps its device sessions. */
export const deviceReleaseApplies = (
  shell: Pick<OrchestrationV2ThreadShell, "settledOverride" | "archivedAt" | "deletedAt"> | null,
) =>
  shell === null ||
  shell.settledOverride === "settled" ||
  shell.archivedAt !== null ||
  shell.deletedAt !== null;

export const makeCleanupEffects = Effect.gen(function* () {
  const resources = yield* ResourceCleanupService.ResourceCleanupService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const run = (effect: OrchestrationEffectV2) => {
    switch (effect.request.type) {
      case "scheduled-tasks.cleanup":
        return resources.cleanupScheduledTasks(effect.threadId);
      case "terminal.cleanup":
        return resources.cleanupTerminals(effect.threadId);
      case "preview.cleanup":
        return resources.cleanupPreviews(effect.threadId);
      case "device.release":
        return threads
          .getThreadShell(effect.threadId)
          .pipe(
            Effect.flatMap((shell) =>
              deviceReleaseApplies(shell) ? resources.cleanupDevices(effect.threadId) : Effect.void,
            ),
          );
      default:
        return Effect.die(new Error(`Not a cleanup effect: ${effect.request.type}`));
    }
  };
  return (effect: OrchestrationEffectV2) =>
    run(effect).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationEffectExecutionError({
            effectId: effect.id,
            effectType: effect.request.type,
            cause,
          }),
      ),
    );
});
