import type {
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestSubmitReviewInput,
  PullRequestDiffResult,
} from "@goat/contracts";
import { create } from "zustand";

type ReviewRevision = NonNullable<PullRequestSubmitReviewInput["revision"]>;
export type PendingReviewComment = PullRequestReviewCommentDraft & {
  readonly id: string;
  readonly sourceRevision?: ReviewRevision | undefined;
};

export function pendingReviewRevision(
  comments: readonly PendingReviewComment[],
  headSha: string | undefined,
  pageRevision?: PullRequestDiffResult["revision"],
) {
  const revision =
    comments.findLast(
      (comment) =>
        comment.sourceRevision?.headSha === headSha &&
        comment.sourceRevision?.baseSha !== undefined,
    )?.sourceRevision ??
    comments.find((comment) => comment.sourceRevision !== undefined)?.sourceRevision;
  const baseSha =
    pageRevision?.headSha === headSha && pageRevision !== undefined
      ? pageRevision.baseSha
      : revision?.baseSha;
  const stale = comments.filter(
    ({ sourceRevision }) =>
      sourceRevision !== undefined &&
      (sourceRevision.headSha !== headSha ||
        (sourceRevision.baseSha !== undefined && sourceRevision.baseSha !== baseSha)),
  );
  return { stale, revision };
}

// Content-derived ids can collide across comments; use a counter.
let pendingCommentSequence = 0;

export function nextPendingReviewCommentId(): string {
  pendingCommentSequence += 1;
  return `pending-review-comment-${pendingCommentSequence}`;
}

export function pullRequestReviewKey(reference: PullRequestRef): string {
  return JSON.stringify([
    reference.projectId,
    reference.host?.toLowerCase() ?? null,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

interface PullRequestReviewStoreState {
  readonly drafts: Readonly<Record<string, ReadonlyArray<PendingReviewComment>>>;
  readonly summaries: Readonly<Record<string, string>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly replaceComment: (key: string, id: string, comment: PendingReviewComment) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  readonly removeComments: (key: string, commentIds: ReadonlyArray<string>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  drafts: {},
  summaries: {},
  addComment: (key, comment) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
    })),
  replaceComment: (key, id, comment) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: (state.drafts[key] ?? EMPTY).map((entry) => (entry.id === id ? comment : entry)),
      },
    })),
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  removeComments: (key, commentIds) =>
    set((state) => {
      const submitted = new Set(commentIds);
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => !submitted.has(entry.id));
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  setSummary: (key, body) => set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
  clearSummary: (key, submittedBody) =>
    set((state) => {
      // Keep summary edits made during submission; the textarea stays editable.
      if (state.summaries[key] !== submittedBody) return state;
      const { [key]: _removed, ...rest } = state.summaries;
      return { summaries: rest };
    }),
}));

export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}
