import type { AnnotationVoiceState } from "@goat/contracts";

export function makeAnnotationVoiceOrdering() {
  let latestState = 0;
  return (state: AnnotationVoiceState) => {
    const applyState = state.sequence > latestState;
    const applyDraft = applyState && state.draft !== null;
    if (applyState) latestState = state.sequence;
    return { applyState, applyDraft };
  };
}

export function annotationVoiceDraftMatches(
  current: { readonly text: string; readonly cursor: number; readonly selectionEnd: number },
  draft: NonNullable<AnnotationVoiceState["draft"]>,
) {
  return (
    current.text === draft.expectedText &&
    current.cursor === draft.expectedCursor &&
    current.selectionEnd === draft.expectedSelectionEnd
  );
}
