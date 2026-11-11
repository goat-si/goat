/** The thread a side chat belongs to, when the device holds it as a live thread. */
export interface SideChatParent {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

/**
 * Null for a thread that is not a side chat. Otherwise the parent to link, or no parent when its
 * shell is missing, not loaded yet, archived, deleted or from another environment.
 */
export function sideChatMarker(
  thread: { readonly environmentId: string; readonly sideChatOf?: string | null },
  candidate: {
    readonly environmentId: string;
    readonly id: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly deletedAt?: string | null;
  } | null,
): { readonly parent: SideChatParent | null } | null {
  if (thread.sideChatOf == null) return null;
  const live =
    candidate !== null &&
    candidate.environmentId === thread.environmentId &&
    candidate.id === thread.sideChatOf &&
    candidate.archivedAt === null &&
    candidate.deletedAt == null;
  return {
    parent: live
      ? { environmentId: candidate.environmentId, threadId: candidate.id, title: candidate.title }
      : null,
  };
}
