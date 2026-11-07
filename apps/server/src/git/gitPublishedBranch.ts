// A branch remote of "." tracks another local branch, which no change request can have as its head.
export function publishedRemoteName(branchRemote: string | null): string | null {
  return branchRemote === "." ? null : branchRemote;
}

export function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}
