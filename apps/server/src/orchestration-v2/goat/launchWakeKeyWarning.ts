import type { OrchestrationV2ServerCommand } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { LAUNCH_WATCH_MESSAGE_PREFIX } from "../../mcp/launchWatch.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { launchWakeKeyCrossing } from "./launchWakeFolds.ts";

/**
 * Logs once when a committed launch wake queued the thread's ninth distinct launching run. Called
 * after the commit and still under the thread's lock, so the read sees exactly that commit's queue;
 * a failed read only skips the warning.
 */
export const warnLaunchWakeKeyCrossing = Effect.fn("launchWakeKeyWarning.warn")(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  command: OrchestrationV2ServerCommand,
) {
  if (command.type !== "message.dispatch") return;
  const key = command.notification?.aboutRunId;
  if (key === undefined || !command.messageId.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX)) return;
  const records = yield* Effect.exit(
    projectionStore.getThreadRecords(command.threadId, ["runs", "messages"]),
  );
  if (!Exit.isSuccess(records)) return;
  const count = launchWakeKeyCrossing(records.value, command.messageId, key);
  if (count !== undefined)
    yield* Effect.logWarning(`Thread ${command.threadId} has ${count} queued launch wake keys`);
});
