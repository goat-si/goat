import type { ActiveAcpTurn } from "./adapter.ts";
import { toolCallVisibleOutputChanged, type AcpToolCallState } from "./runtimeModel.ts";

const TOOL_UPDATE_PERSIST_EVERY = 10;

// Agents can resend whole calls while streaming arguments.
export function shouldPersistToolUpdate(
  context: Pick<ActiveAcpTurn, "toolUpdatesSkipped">,
  key: string,
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
  reportedStatus: AcpToolCallState["status"],
): boolean {
  const skipped = context.toolUpdatesSkipped.get(key) ?? 0;
  const persist =
    reportedStatus === "completed" ||
    reportedStatus === "failed" ||
    previous === undefined ||
    previous.status !== next.status ||
    previous.title !== next.title ||
    toolCallVisibleOutputChanged(previous, next) ||
    skipped + 1 >= TOOL_UPDATE_PERSIST_EVERY;
  context.toolUpdatesSkipped.set(key, persist ? 0 : skipped + 1);
  return persist;
}
