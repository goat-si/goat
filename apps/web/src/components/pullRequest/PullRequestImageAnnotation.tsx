import type { FileDiffMetadata } from "@pierre/diffs";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type EnvironmentId,
  type PullRequestDetailView,
} from "@goat/contracts";
import { isWorkspaceImagePreviewPath } from "@goat/shared/mediaPreview";

import { ChatMarkdownAssetImage } from "../chat/ChatMarkdownMedia";

export interface PullRequestImagePreview {
  readonly url: string;
  readonly path: string;
}

/** Hosts send no patch for an image, so its expanded row shows the file at this revision. */
export function pullRequestImagePreviewUrl(
  detail: Pick<PullRequestDetailView, "provider" | "url" | "headSha">,
  commit: string | null,
) {
  const revision = commit ?? detail.headSha;
  const rawFileUrl = sourceControlClients.find(detail.provider)?.rawFileUrl;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(detail.url)?.link.repositoryUrl;
  return (fileDiff: FileDiffMetadata, path: string): string | null =>
    fileDiff.hunks.length === 0 &&
    fileDiff.type !== "deleted" &&
    isWorkspaceImagePreviewPath(path) &&
    revision !== undefined &&
    rawFileUrl !== undefined &&
    repositoryUrl !== undefined
      ? rawFileUrl({ repositoryUrl, sha: revision, path })
      : null;
}

export function PullRequestImageAnnotation(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: Pick<PullRequestDetailView, "workspaceRoot" | "repository">;
  readonly image: PullRequestImagePreview;
}) {
  return (
    <div className="flex justify-center p-3">
      <ChatMarkdownAssetImage
        environmentId={props.environmentId}
        resource={{
          _tag: SOURCE_CONTROL_MEDIA_ASSET,
          cwd: props.detail.workspaceRoot,
          url: props.image.url,
          repository: props.detail.repository,
        }}
        alt={props.image.path}
      />
    </div>
  );
}
