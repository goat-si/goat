import type { OrchestrationV2ProjectedTurnItem, RunId, ScopedThreadRef } from "@goat/contracts";
import {
  extractFilePatch,
  fileChangeTargetPaths,
  INLINE_DIFF_MAX_LINES,
  inlineDiffLineCount,
} from "@goat/client-runtime/work-log/file-change-diff";
import { turnItemDetailRevision } from "@goat/client-runtime/work-log/item-detail";
import { workspaceRelativeFilePath } from "@goat/shared/path";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { memo, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import type { DiffPanelSourceItem, OpenTurnDiff } from "../../diffPanelStore";
import { useCheckpointDiff } from "../../lib/checkpointDiffState";
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  findPatchFile,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { useThreadCheckpointSummaries } from "../../state/entities";
import { useTurnItemDetail } from "../../state/queries";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DiffStatLabel } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";

function InlineDiffNote({ children }: { children: ReactNode }) {
  return <p className="ms-7 py-1 text-xs text-muted-foreground">{children}</p>;
}

// Every expanded row of a turn reads the same patch; parse it once per patch and theme.
const parsedPatchCache = new Map<string, ReadonlyArray<FileDiffMetadata>>();
const PARSED_PATCH_CACHE_SIZE = 16;

function parsePatch(patch: string, scope: string): ReadonlyArray<FileDiffMetadata> {
  const key = `${scope}\u0000${patch}`;
  const cached = parsedPatchCache.get(key);
  if (cached !== undefined) return cached;
  const renderable = getRenderablePatch(patch, scope);
  const files = renderable?.kind === "files" ? renderable.files : [];
  parsedPatchCache.set(key, files);
  const oldest = parsedPatchCache.keys().next().value;
  if (parsedPatchCache.size > PARSED_PATCH_CACHE_SIZE && oldest !== undefined) {
    parsedPatchCache.delete(oldest);
  }
  return files;
}

function matchPatchFiles(
  files: ReadonlyArray<FileDiffMetadata>,
  paths: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
): ReadonlyArray<FileDiffMetadata> {
  const matched = paths.flatMap((path) => {
    const file = findPatchFile(files, path, workspaceRoot);
    return file === null ? [] : [file];
  });
  return [...new Set(matched)];
}

/**
 * What one edit changed. Its own patch comes from getTurnItem when the provider reported one,
 * so it shows mid-turn and apart from later edits to the same file. Otherwise, and from servers
 * that send no patch, it is the turn's checkpoint diff, the same cached query the diff panel reads.
 */
export const FileChangeInlineDiff = memo(function FileChangeInlineDiff(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly runId: RunId;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenTurnDiff: OpenTurnDiff;
}) {
  const { threadRef, projectedItem, runId, workspaceRoot, resolvedTheme, onOpenTurnDiff } = props;
  const wireItem = projectedItem.item;
  const paths = wireItem.type === "file_change" ? fileChangeTargetPaths(wireItem) : [];
  const hasOwnPatch = wireItem.type === "file_change" && wireItem.patchOmitted === true;
  const sourceItem: DiffPanelSourceItem = {
    threadId: projectedItem.sourceThreadId,
    itemId: projectedItem.sourceItemId,
    revision: turnItemDetailRevision(wireItem),
  };
  const detail = useTurnItemDetail(
    hasOwnPatch ? { environmentId: threadRef.environmentId, ...sourceItem } : null,
  );
  const fetched = detail.data?.item;
  const ownPatch = fetched?.type === "file_change" ? fetched.patch : undefined;
  const awaitingOwnPatch = hasOwnPatch && detail.isPending && !detail.error;
  const usesCheckpoint = ownPatch === undefined && !awaitingOwnPatch;

  const ignoreWhitespace = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const summary = useThreadCheckpointSummaries(threadRef).find(
    (candidate) => candidate.runId === runId,
  );
  const turnCount = summary?.checkpointTurnCount ?? null;
  const diff = useCheckpointDiff(
    {
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      fromTurnCount: turnCount === null ? null : Math.max(0, turnCount - 1),
      toTurnCount: turnCount,
      ignoreWhitespace,
      cacheScope: `turn:${runId}`,
    },
    { enabled: usesCheckpoint && summary !== undefined },
  );

  // The panel's cache scope, so its highlighting cache is shared too.
  const scope = `diff-panel:${resolvedTheme}`;
  if (ownPatch !== undefined) {
    const files = parsePatch(ownPatch, scope);
    const matched = matchPatchFiles(files, paths, workspaceRoot);
    return (
      <FileDiffCards
        files={matched.length > 0 ? matched : files}
        patch={ownPatch}
        runId={runId}
        sourceItem={sourceItem}
        workspaceRoot={workspaceRoot}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    );
  }
  if (awaitingOwnPatch) return <InlineDiffNote>Loading diff…</InlineDiffNote>;
  if (summary === undefined) {
    return <InlineDiffNote>The diff appears when this turn finishes.</InlineDiffNote>;
  }
  const patch = diff.data?.diff;
  if (patch === undefined) {
    return diff.error ? (
      <InlineDiffNote>{diff.error}</InlineDiffNote>
    ) : (
      <InlineDiffNote>Loading diff…</InlineDiffNote>
    );
  }
  const matched = matchPatchFiles(parsePatch(patch, scope), paths, workspaceRoot);
  if (matched.length === 0) {
    return <InlineDiffNote>No net change to this file by the end of the turn.</InlineDiffNote>;
  }
  return (
    <FileDiffCards
      files={matched}
      patch={patch}
      runId={runId}
      workspaceRoot={workspaceRoot}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function FileDiffCards(props: {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly patch: string;
  readonly runId: RunId;
  /** Set when the cards show the edit's own patch, which the panel can show mid-turn. */
  readonly sourceItem?: DiffPanelSourceItem;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenTurnDiff: OpenTurnDiff;
}) {
  const { files, patch, runId, sourceItem, workspaceRoot, resolvedTheme, onOpenTurnDiff } = props;
  return (
    // The row toggles on Enter and Space; keys pressed on the card's buttons stay here.
    <div className="flex flex-col gap-2" onKeyDown={(event) => event.stopPropagation()}>
      {files.map((file) => {
        const filePath = resolveFileDiffPath(file);
        // An edit's patch is repo-relative inside the workspace, and absolute outside it.
        const displayPath = workspaceRelativeFilePath(filePath, workspaceRoot) ?? filePath;
        const stat = getDiffLineStat([file]);
        const filePatch = extractFilePatch(patch, file);
        const lineCount = inlineDiffLineCount(file);
        const tooLarge = lineCount > INLINE_DIFF_MAX_LINES;
        return (
          <div
            key={filePath}
            className="overflow-hidden rounded-lg border border-border/70 bg-(--code-background)"
            data-file-change-inline-diff={filePath}
          >
            <div className="flex min-w-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-2.5 py-1 text-xs">
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 truncate font-mono text-foreground/80" />}
                >
                  {displayPath}
                </TooltipTrigger>
                <TooltipPopup>{filePath}</TooltipPopup>
              </Tooltip>
              <DiffStatLabel
                additions={stat.additions}
                deletions={stat.deletions}
                layout="inline"
                className="shrink-0"
              />
              <span className="flex-1" />
              {filePatch.length > 0 ? (
                <MessageCopyButton
                  text={filePatch}
                  label="Copy diff"
                  size="icon-xs"
                  variant="ghost"
                />
              ) : null}
            </div>
            {tooLarge ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
                <span>{lineCount.toLocaleString()} lines is too long to show here.</span>
                <InlineButton onClick={() => onOpenTurnDiff(runId, filePath, sourceItem)}>
                  Show full diff in panel
                </InlineButton>
              </div>
            ) : (
              <div className="max-h-72 overflow-auto">
                <DiffWorkerPoolProvider>
                  <FileDiff
                    fileDiff={file}
                    options={{
                      collapsed: false,
                      diffStyle: "unified",
                      disableFileHeader: true,
                      hunkSeparators: "simple",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
                    }}
                  />
                </DiffWorkerPoolProvider>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
