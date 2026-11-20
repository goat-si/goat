export function captureBackgroundVoiceDraft(input: {
  readonly ownerKey: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly read: () => string | null;
  readonly exists: () => boolean;
  readonly write: (text: string) => void;
  readonly subscribe: (callback: () => void) => () => void;
}) {
  let current = input.read();
  let revision = 0;
  const unsubscribe = input.subscribe(() => {
    const next = input.read();
    if (next !== current) revision++;
    current = next;
  });
  return {
    readDraft: () =>
      input.exists()
        ? { ownerKey: input.ownerKey, text: current ?? "", revision, selection: input.selection }
        : null,
    commitDraft: input.write,
    dispose: unsubscribe,
  };
}
