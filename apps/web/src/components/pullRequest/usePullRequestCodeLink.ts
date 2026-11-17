import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import {
  parsePullRequestAnchor,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
} from "@goat/shared/pullRequestAnchor";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { toViewerSide } from "./PullRequestReviewAnnotation";

/** The file a clicked diff link names among the loaded files, and the one it last revealed. */
export function useCodeLinkTarget(
  revealUrl: string | undefined,
  loadedFiles: ReadonlyArray<FileDiffMetadata>,
  scopeKey: string,
) {
  const anchor = parsePullRequestAnchor(revealUrl);
  const file =
    anchor?.kind === "diff"
      ? loadedFiles.find((entry) =>
          pullRequestDiffPathMatches(anchor.digest, resolveFileDiffPath(entry)),
        )
      : undefined;
  const pendingPath = file ? resolveFileDiffPath(file) : null;
  // The linked file stays shown past the test-file filter after the link settles.
  const [revealed, setRevealed] = useState<{
    readonly scope: string;
    readonly path: string;
  } | null>(null);
  return {
    anchor,
    pendingPath,
    path: pendingPath ?? (revealed?.scope === scopeKey ? revealed.path : null),
    markRevealed: (path: string) => setRevealed({ scope: scopeKey, path }),
  };
}

/** Pages the diff forward to a clicked file or line range and scrolls to it once it renders. */
export function useRevealCodeLink(input: {
  readonly revealUrl: string | undefined;
  readonly onRevealSettled: ((revealUrl: string) => void) | undefined;
  readonly link: ReturnType<typeof useCodeLinkTarget>;
  readonly commit: string | null;
  readonly commitOids: ReadonlyArray<string>;
  readonly scopeKey: string;
  readonly items: ReadonlyArray<{ readonly fileDiff: FileDiffMetadata }>;
  readonly canLoadNextSlice: boolean;
  readonly loadNextSlice: () => void;
  readonly everyPageLoaded: boolean;
  readonly revealFile: (path: string, range?: SelectedLineRange) => void;
}) {
  const { revealUrl, link, items, canLoadNextSlice } = input;
  // The store clears a settled link after this render, so one link must not reveal twice.
  const answeredLink = useRef<string | null>(null);
  const revealLink = useEffectEvent(() => {
    if (revealUrl === undefined) answeredLink.current = null;
    if (revealUrl === undefined || link.anchor?.kind !== "diff") return;
    // The panel selects the link's commit after this tab's effects run, so the files on screen
    // can still be another commit's.
    const linkCommit = pullRequestLinkCommit(revealUrl);
    const shownCommit = input.commitOids.some((oid) => oid === linkCommit) ? linkCommit : null;
    if (shownCommit !== input.commit) return;
    const key = `${input.scopeKey}:${revealUrl}`;
    if (answeredLink.current === key) return;
    const path = link.pendingPath;
    if (!path || !items.some((item) => resolveFileDiffPath(item.fileDiff) === path)) {
      if (canLoadNextSlice) input.loadNextSlice();
      // Every page is loaded and none has the file.
      else if (!path && input.everyPageLoaded) {
        answeredLink.current = key;
        input.onRevealSettled?.(revealUrl);
      }
      return;
    }
    answeredLink.current = key;
    link.markRevealed(path);
    input.onRevealSettled?.(revealUrl);
    const range = link.anchor.range;
    input.revealFile(
      path,
      range
        ? {
            start: range.start,
            end: range.end,
            side: toViewerSide(range.side),
            endSide: toViewerSide(range.endSide),
          }
        : undefined,
    );
  });
  // oxlint-disable-next-line goat/react-effect-budget -- pages and scrolls the virtual diff to a clicked file or line range
  useEffect(() => {
    revealLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retries the reveal as diff pages and viewer items arrive
  }, [revealUrl, link.pendingPath, canLoadNextSlice, items]);
}
