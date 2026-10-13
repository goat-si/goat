import { isSideChatThread, type OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
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

export type SideChatRow =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
    };

/**
 * The exchange the side chat itself produced. A forked side chat also projects its parent's
 * history as inherited items; that history stays in the parent's own view.
 */
export function sideChatRows(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): SideChatRow[] {
  const rows: SideChatRow[] = [];
  for (const { item, visibility } of items) {
    if (visibility !== "local") continue;
    if (item.type === "user_message" && item.text.trim() !== "") {
      rows.push({ kind: "user", id: item.id, text: item.text });
    } else if (item.type === "assistant_message" && (item.text !== "" || item.streaming)) {
      rows.push({ kind: "assistant", id: item.id, text: item.text, streaming: item.streaming });
    }
  }
  return rows;
}
