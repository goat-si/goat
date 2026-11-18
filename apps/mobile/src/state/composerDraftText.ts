export function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}
