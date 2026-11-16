import { type OrchestratorMcpThreadListItem, ThreadId } from "@goat/contracts";

export const item = (
  threadId: string,
  updatedAt: string,
  host?: string,
): OrchestratorMcpThreadListItem =>
  ({
    threadId: ThreadId.make(threadId),
    updatedAt,
    ...(host === undefined ? {} : { host }),
  }) as OrchestratorMcpThreadListItem;
