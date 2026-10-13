import { isSideChatThread } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { ScopedThreadRef } from "@goat/contracts";

/** `/side` or `/side <question>` sent from a thread's composer. */
export function parseSideChatCommand(text: string): { readonly prompt: string } | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { prompt: match[1]?.trim() ?? "" };
}

/**
 * The side chat a thread shows: its newest live one. Clearing a side chat deletes it, so
 * older live ones only exist when another client started one at the same time.
 */
export function findSideChatThread(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  parent: ScopedThreadRef,
): EnvironmentThreadShell | null {
  let latest: EnvironmentThreadShell | null = null;
  for (const shell of shells) {
    if (
      shell.environmentId !== parent.environmentId ||
      shell.sideChatOf !== parent.threadId ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null
    )
      continue;
    if (latest === null || shell.createdAt > latest.createdAt) latest = shell;
  }
  return latest;
}

export function canOpenSideChat(
  thread: { readonly sideChatOf?: ScopedThreadRef["threadId"] | null | undefined } | null,
): boolean {
  return thread !== null && !isSideChatThread(thread);
}
