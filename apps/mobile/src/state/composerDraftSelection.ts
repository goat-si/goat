import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

interface ComposerDraftSelection {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

// Keep each draft's caret across composer unmounts without notifying other drafts.
const composerDraftSelectionAtom = Atom.family((_draftKey: string) =>
  Atom.make<ComposerDraftSelection | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:composer-draft-selection"),
  ),
);
const NO_COMPOSER_DRAFT_SELECTION_ATOM = Atom.make<ComposerDraftSelection | null>(null);

export function rememberComposerDraftSelection(
  draftKey: string,
  text: string,
  selection: { start: number; end: number },
): void {
  appAtomRegistry.set(composerDraftSelectionAtom(draftKey), { text, ...selection });
}

function matchingComposerDraftSelection(
  selection: ComposerDraftSelection | null,
  text: string,
): { start: number; end: number } | null {
  if (selection?.text !== text) return null;
  return { start: selection.start, end: selection.end };
}

export function readComposerDraftSelection(
  draftKey: string,
  text: string,
): { start: number; end: number } | null {
  return matchingComposerDraftSelection(
    appAtomRegistry.get(composerDraftSelectionAtom(draftKey)),
    text,
  );
}

export function useComposerDraftSelection(
  draftKey: string | null,
  text: string,
): { start: number; end: number } | null {
  const selection = useAtomValue(
    draftKey === null ? NO_COMPOSER_DRAFT_SELECTION_ATOM : composerDraftSelectionAtom(draftKey),
  );
  return draftKey === null ? null : matchingComposerDraftSelection(selection, text);
}
