/**
 * Workspace choices the user made per draft (mode, base branch). A default that arrives after a
 * draft opened compares counts to tell a deliberate pick from a value that merely equals it, such
 * as choosing Local again or picking the branch the selector would have seeded.
 */
const picksByDraft = new Map<string, number>();

export function noteDraftWorkspacePick(draftId: string): void {
  picksByDraft.set(draftId, (picksByDraft.get(draftId) ?? 0) + 1);
}

export function draftWorkspacePickCount(draftId: string): number {
  return picksByDraft.get(draftId) ?? 0;
}
