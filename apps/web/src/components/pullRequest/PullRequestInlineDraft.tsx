import { useAtomValue } from "@effect/atom-react";
import { REVISION_REVIEW_UNAVAILABLE } from "@goat/client-runtime/state/pull-requests";
import { Atom } from "effect/reactivity";
import { pullRequestEnvironment } from "~/state/pullRequests";
import type { EnvironmentId, PullRequestReviewPosition } from "@goat/contracts";
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { buildFileDiffContentVersion, buildFileDiffIdentityKey } from "~/lib/diffRendering";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import type { PullRequestCompletionScope } from "./PullRequestMarkdownTextarea";
import { getReviewPositionAnchor } from "./PullRequestReviewAnnotation";
import {
  nextPendingReviewCommentId,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

export interface DraftAnchor {
  // A refresh re-keys every file's render key, so the draft finds its file by identity and content.
  readonly identityKey: string;
  readonly fileVersion: number;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
  readonly openedHeadSha: string | undefined;
  readonly sourceRevision?: PendingReviewComment["sourceRevision"];
  readonly moving?: PendingReviewComment | undefined;
}

export function draftFileIdentity(file: FileDiffMetadata) {
  return {
    identityKey: buildFileDiffIdentityKey(file),
    fileVersion: buildFileDiffContentVersion(file),
  };
}

export function resolveDraftFile(
  draft: DraftAnchor | null,
  loadedFiles: readonly FileDiffMetadata[],
  fileRenderKey: (file: FileDiffMetadata) => string,
  allPagesLoaded: boolean,
): {
  readonly file: FileDiffMetadata | undefined;
  readonly fileKey: string | null;
  readonly invalid: boolean;
} {
  if (draft === null) return { file: undefined, fileKey: null, invalid: false };
  const file = loadedFiles.find(
    (candidate) => buildFileDiffIdentityKey(candidate) === draft.identityKey,
  );
  const fileKey =
    file !== undefined && buildFileDiffContentVersion(file) === draft.fileVersion
      ? fileRenderKey(file)
      : null;
  // Never attach the draft to lines of a changed file; one missing mid-refresh may come back.
  const invalid = fileKey === null && (file !== undefined || allPagesLoaded);
  return { file, fileKey, invalid };
}

const UNBOUND_REVIEW = Atom.make(() => true);

export function PullRequestInlineDraft({
  draft,
  text,
  onTextChange,
  environmentId,
  reviewKey,
  completionScope,
  canComment,
  onAddToAgent,
  onClose,
}: {
  readonly draft: DraftAnchor;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly environmentId: EnvironmentId;
  readonly reviewKey: string;
  readonly completionScope: PullRequestCompletionScope | null;
  readonly canComment: boolean;
  readonly onAddToAgent?: ((body: string) => void) | undefined;
  readonly onClose: () => void;
}) {
  const revisionReviewSupported = useAtomValue(
    canComment && draft.sourceRevision !== undefined
      ? pullRequestEnvironment.revisionReviewSupported(environmentId)
      : UNBOUND_REVIEW,
  );
  const queueComment = (body: string) => {
    if (!revisionReviewSupported) return;
    if (!canComment) {
      onAddToAgent?.(body);
      return;
    }
    const comment = {
      id: nextPendingReviewCommentId(),
      path: draft.path,
      ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
      ...(draft.startPosition === undefined ? {} : { startPosition: draft.startPosition }),
      ...(draft.sourceRevision === undefined ? {} : { sourceRevision: draft.sourceRevision }),
      position: draft.position,
      body,
    };
    const store = usePullRequestReviewStore.getState();
    if (draft.moving) store.replaceComment(reviewKey, draft.moving.id, comment);
    else store.addComment(reviewKey, comment);
    onClose();
  };

  return (
    <DiffCommentAnnotation
      environmentId={environmentId}
      kind="draft"
      rangeLabel={draft.path + ":" + getReviewPositionAnchor(draft.position).line}
      text={text}
      onTextChange={onTextChange}
      completionScope={canComment ? completionScope : null}
      submitDisabledReason={revisionReviewSupported ? undefined : REVISION_REVIEW_UNAVAILABLE}
      submitLabel={
        canComment ? (draft.moving ? "Move comment here" : "Add to review") : "Add to agent"
      }
      {...(canComment && onAddToAgent && !draft.moving
        ? { secondaryAction: { label: "Add to agent", onAction: onAddToAgent } }
        : {})}
      onCancel={onClose}
      onComment={queueComment}
    />
  );
}
