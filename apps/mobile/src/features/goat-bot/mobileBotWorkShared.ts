import { botHomeWork } from "@goat/client-runtime/goatBot";
import type { BotRemoteWork, BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";

// Moves to @goat/client-runtime/goatBot with lane W's shared PR.
export const COLLAPSED_FINISHED = 5;

// Moves to @goat/client-runtime/goatBot with lane W's shared PR.
export function accessDenied(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    (failure as { readonly _tag?: unknown })._tag === "EnvironmentAuthorizationError"
  );
}

// Moves to @goat/client-runtime/goatBot with lane W's shared PR.
export function workRowCollapsed(
  rows: ReadonlyArray<BotThreadRow>,
  environmentId: EnvironmentId,
  remoteWork: ReadonlyArray<BotRemoteWork>,
  taskId: ChannelTaskId,
): boolean {
  return botHomeWork(rows, [], environmentId, remoteWork)
    .finished.slice(COLLAPSED_FINISHED)
    .some((task) => task.row.task.taskId === taskId);
}
