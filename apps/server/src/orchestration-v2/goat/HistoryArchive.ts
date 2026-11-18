import type { OrchestrationV2Command } from "@goat/contracts";

export function withoutHistoryArchive<T extends { readonly historyArchive?: unknown }>(thread: T) {
  const { historyArchive: _historyArchive, ...rest } = thread;
  return rest;
}

/** A metadata update that only records where the tool history lives. */
export function isHistoryArchiveOnlyUpdate(
  command: Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>,
): boolean {
  const {
    type: _type,
    commandId: _commandId,
    threadId: _threadId,
    historyArchive,
    ...rest
  } = command;
  return historyArchive !== undefined && Object.values(rest).every((value) => value === undefined);
}
