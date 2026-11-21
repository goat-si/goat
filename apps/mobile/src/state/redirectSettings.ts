import type { SetThreadRuntimeModeInput } from "@goat/client-runtime/operations";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { CommandId, type EnvironmentId, type RuntimeMode, type ThreadId } from "@goat/contracts";

import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

type SetRuntimeMode = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: SetThreadRuntimeModeInput;
}) => Promise<AtomCommandResult<unknown, unknown>>;

interface RedirectThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly runtimeMode: RuntimeMode;
}

interface RedirectMessage {
  readonly commandId: string;
  readonly createdAt: string;
}

/**
 * The screen's step before a message redirects pending approvals. It calls saveMode only on the
 * decline path (after approval feedback and its own early returns), as web orders it.
 */
export type RedirectBeforeDispatch = (
  text: string,
  hasAttachmentsOrContext: boolean,
  saveMode: () => Promise<boolean>,
) => Promise<boolean | "responded">;

/**
 * A redirect declines pending approvals, so a mode change it carries is saved first: a server
 * that refuses it while the turn runs (goat#3558) then declines nothing, as on web. The command
 * id is the one the outbox's settings step uses for this message, so the server applies it once.
 * Resolves to the refusal's text, or null once saved or not needed.
 */
async function saveRuntimeModeBeforeRedirect(
  setRuntimeMode: SetRuntimeMode,
  thread: RedirectThread,
  runtimeMode: RuntimeMode | undefined,
  message: RedirectMessage,
): Promise<string | null> {
  if (runtimeMode === undefined || runtimeMode === thread.runtimeMode) return null;
  const result = await setRuntimeMode({
    environmentId: thread.environmentId,
    input: {
      commandId: CommandId.make(`${message.commandId}:runtime-mode`),
      threadId: thread.id,
      runtimeMode,
      createdAt: message.createdAt,
    },
  });
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Failed to send message.";
}

export function useSaveRuntimeModeBeforeRedirect() {
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  return (thread: RedirectThread, runtimeMode: RuntimeMode | undefined, message: RedirectMessage) =>
    saveRuntimeModeBeforeRedirect(setRuntimeMode, thread, runtimeMode, message);
}
