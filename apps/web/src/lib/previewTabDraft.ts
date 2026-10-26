import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type EnvironmentId,
  type PreviewTabContextRecord,
  type PreviewSessionSnapshot,
} from "@goat/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@goat/shared/composerContextReferences";
import type {
  ComposerContextAddOptions,
  ComposerContextInsertionHandler,
  ComposerThreadDraftState,
  ComposerThreadTarget,
} from "~/composerDraftStore";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
} from "./composerContextReferences";
type DraftState = { draftsByThreadKey: Record<string, ComposerThreadDraftState> };

/**
 * The typed record the composer inserts for a live server browser tab. The @ menu rebuilds this
 * on every recompute, so the id comes from the tab: picking one tab twice reuses its chip.
 */
export function previewTabRecordForServerTab(
  environmentId: EnvironmentId,
  tab: { readonly tabId: string; readonly title: string; readonly url: string },
): PreviewTabContextRecord {
  return {
    version: 1,
    kind: "preview-tab",
    contextId: toKindScopedComposerContextId(
      "preview-tab",
      `${environmentId}:${SERVER_BROWSER_AUTOMATION_CLIENT_ID}:${tab.tabId}`,
    ),
    label: sanitizeComposerContextLabel(tab.title || tab.url, "browser tab"),
    environmentId,
    browserInstanceId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
    tabId: tab.tabId,
    title: sanitizeComposerContextLabel(tab.title, "browser tab"),
    url: tab.url,
  };
}

/** The @ menu rows for this environment's live server browser tabs that match the typed query. */
export function previewTabMenuItems(
  typed: string,
  sessions: ReadonlyArray<PreviewSessionSnapshot> | undefined,
  environmentId: EnvironmentId,
) {
  return (sessions ?? []).flatMap((session) => {
    if (session.runtime !== "server" || session.navStatus._tag === "Idle") return [];
    const { title, url } = session.navStatus;
    const query = typed.trim().toLowerCase();
    if (
      query &&
      ![title, url, "tab", "browser"].some((value) => value.toLowerCase().includes(query))
    )
      return [];
    return [
      {
        id: `preview-tab:${session.tabId}`,
        type: "preview-tab" as const,
        record: previewTabRecordForServerTab(environmentId, {
          tabId: session.tabId,
          title,
          url,
        }),
        label: title || url,
        description: url,
      },
    ];
  });
}

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

export interface PreviewTabDraftActions {
  addPreviewTabs: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<PreviewTabContextRecord>,
    options?: ComposerContextAddOptions,
  ) => void;
  setPreviewTabs: (
    threadRef: ComposerThreadTarget,
    records: ReadonlyArray<PreviewTabContextRecord>,
  ) => void;
}

/** The draft store's preview-tab actions, over the store's own key lookup and caret handlers. */
export function previewTabDraftActions<S extends DraftState>(
  set: (update: (state: S) => S) => void,
  get: () => S,
  store: {
    readonly resolveComposerDraftKey: (state: S, target: ComposerThreadTarget) => string | null;
    readonly contextInsertionHandlers: ReadonlyMap<string, ComposerContextInsertionHandler>;
    readonly createEmptyThreadDraft: () => ComposerThreadDraftState;
  },
): PreviewTabDraftActions {
  return {
    addPreviewTabs: (threadRef, records, options) => {
      const threadKey = store.resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const placedAtCaret =
        options?.appendReference !== false &&
        options?.insertAtCaret !== false &&
        (store.contextInsertionHandlers.get(threadKey)?.(records) ?? false);
      set((state) =>
        addPreviewTabsToDraftState(
          state,
          threadKey,
          records,
          placedAtCaret,
          options?.appendReference === false,
          store.createEmptyThreadDraft(),
        ),
      );
    },
    setPreviewTabs: (threadRef, records) => {
      const threadKey = store.resolveComposerDraftKey(get(), threadRef);
      if (threadKey)
        set((state) =>
          setPreviewTabsInDraftState(state, threadKey, records, store.createEmptyThreadDraft()),
        );
    },
  };
}
