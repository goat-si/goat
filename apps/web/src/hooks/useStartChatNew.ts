import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext, startNewThreadFromLastWork } from "../lib/chatThreadActions";
import { readThreadShells, readProjects } from "../state/entities";
import { readNewThreadContext } from "./useHandleNewThread";

/**
 * Open a draft in the last worked project; the draft's own picker changes it.
 * Ask for a project only when nothing can be started.
 */
export function useStartChatNew(): () => Promise<void> {
  return createStartChatNew(useRouter());
}

export function createStartChatNew(router: AnyRouter): () => Promise<void> {
  return async () => {
    const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
      readNewThreadContext(router);
    // Read shells at call time so callers do not re-render on every thread update.
    const threads = readThreadShells();
    if (await startNewThreadFromLastWork({ threads, projects: readProjects(), handleNewThread })) {
      return;
    }
    const started = await startNewThreadFromContext({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    if (!started) openCommandPalette({ open: "new-thread-in" });
  };
}
