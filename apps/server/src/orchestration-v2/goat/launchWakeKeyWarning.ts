import type { OrchestrationV2ServerCommand } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { LAUNCH_WATCH_MESSAGE_PREFIX } from "../../mcp/launchWatch.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { launchWakeKeyCrossing } from "./launchWakeFolds.ts";

const crossing = Effect.fn("launchWakeKeyWarning.warn")(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  command: OrchestrationV2ServerCommand,
) {
  if (command.type !== "message.dispatch") return;
  const key = command.notification?.aboutRunId;
  if (key === undefined || !command.messageId.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX)) return;
  const records = yield* projectionStore.getThreadRecords(command.threadId, ["runs", "messages"]);
  const count = launchWakeKeyCrossing(records, command.messageId, key);
  if (count !== undefined)
    yield* Effect.logWarning(`Thread ${command.threadId} has ${count} queued launch wake keys`);
});

/**
 * Logs once when a committed launch wake queued the thread's ninth distinct launching run. It runs
 * under the thread's lock right after the commit: any failure in it is swallowed with a debug log,
 * and it is uninterruptible, so an outside interruption takes effect only after its one read.
 */
export const warnLaunchWakeKeyCrossing = (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  command: OrchestrationV2ServerCommand,
) =>
  Effect.exit(crossing(projectionStore, command)).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.logDebug("launch wake key warning skipped", { cause: exit.cause }),
    ),
    Effect.uninterruptible,
  );
