export function parseSideChatCommand(text: string): { prompt: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { prompt: match[1]?.trim() ?? "" } : null;
}

export function findSideChat<
  T extends {
    readonly environmentId: string;
    readonly sideChatOf?: string | null;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
    readonly createdAt: string;
  },
>(threads: ReadonlyArray<T>, environmentId: string, parentId: string): T | null {
  let newest: T | null = null;
  for (const thread of threads) {
    if (
      thread.environmentId !== environmentId ||
      thread.sideChatOf !== parentId ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    )
      continue;
    if (newest === null || thread.createdAt > newest.createdAt) newest = thread;
  }
  return newest;
}
