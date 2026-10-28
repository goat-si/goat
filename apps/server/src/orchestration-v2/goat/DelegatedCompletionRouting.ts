import { isGoatBotSessionThreadId, type RunId, type ThreadId } from "@goat/contracts";

/**
 * Whether a child's completion may join a running turn. A GOAT Bot session serves one task per
 * run, so there it joins only the run that started the child; elsewhere it joins the live turn.
 */
export const canSteerDelegatedCompletionIntoRun = (
  threadId: ThreadId,
  parentRunId: RunId,
  activeRunId: RunId,
) => !isGoatBotSessionThreadId(threadId) || activeRunId === parentRunId;
