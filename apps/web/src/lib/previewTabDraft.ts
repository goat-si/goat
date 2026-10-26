import type { PreviewTabContextRecord } from "@goat/contracts";
import type { ComposerThreadDraftState } from "~/composerDraftStore";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
} from "./composerContextReferences";

type DraftState = { draftsByThreadKey: Record<string, ComposerThreadDraftState> };

export function addPreviewTabsToDraftState<S extends DraftState>(
  state: S,
  threadKey: string,
  records: ReadonlyArray<PreviewTabContextRecord>,
  placedAtCaret: boolean,
  skipAppend: boolean,
  emptyDraft: ComposerThreadDraftState,
): S {
  const existing = state.draftsByThreadKey[threadKey] ?? emptyDraft;
  const known = new Set(existing.previewTabs.map((record) => record.contextId));
  const accepted = records.filter((record) => !known.has(record.contextId));
  if (accepted.length === 0) return state;
  return {
    ...state,
    draftsByThreadKey: {
      ...state.draftsByThreadKey,
      [threadKey]: {
        ...existing,
        prompt:
          placedAtCaret || skipAppend
            ? existing.prompt
            : ensureInlineContextReferences(existing.prompt, accepted),
        previewTabs: [...existing.previewTabs, ...accepted],
      },
    },
  };
}

export function setPreviewTabsInDraftState<S extends DraftState>(
  state: S,
  threadKey: string,
  records: ReadonlyArray<PreviewTabContextRecord>,
  emptyDraft: ComposerThreadDraftState,
): S {
  const existing = state.draftsByThreadKey[threadKey] ?? emptyDraft;
  const retained = new Set(records.map((record) => record.contextId));
  let prompt = existing.prompt;
  for (const previous of existing.previewTabs) {
    if (!retained.has(previous.contextId))
      prompt = removeInlineContextReference(prompt, previous.contextId).prompt;
  }
  return {
    ...state,
    draftsByThreadKey: {
      ...state.draftsByThreadKey,
      [threadKey]: {
        ...existing,
        prompt: ensureInlineContextReferences(prompt, records),
        previewTabs: [...records],
      },
    },
  };
}
