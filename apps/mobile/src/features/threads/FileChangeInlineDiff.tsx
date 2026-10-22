import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import {
  extractFilePatch,
  fileChangeTargetPaths,
  findPatchFile,
  INLINE_DIFF_MAX_LINES,
  inlineDiffLineCount,
  resolveFileDiffPath,
} from "@goat/client-runtime/work-log/file-change-diff";
import type { ThreadCheckpointSummary } from "@goat/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { workspaceRelativeFilePath } from "@goat/shared/path";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useCheckpointDiff, useTurnItemDetail } from "../../state/queries";
import { environmentThreadDetails } from "../../state/threads";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import { buildNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PullRequestDiffStats } from "../pull-requests/PullRequestPresentation";
import { CopyTextButton } from "./CopyTextButton";

const EMPTY_IDS: readonly string[] = [];
const MAX_CARD_HEIGHT = 288;
const EMPTY_CHECKPOINT_SUMMARIES_ATOM = Atom.make<ReadonlyArray<ThreadCheckpointSummary>>(
  Object.freeze([]),
).pipe(Atom.withLabel("mobile-inline-diff-checkpoints:empty"));

function InlineDiffNote(props: { readonly children: string }) {
  return <Text className="ml-7 py-1 text-xs text-foreground-muted">{props.children}</Text>;
}

function patchFiles(patch: string, scope: string): ReadonlyArray<FileDiffMetadata> {
  try {
    return parsePatchFiles(patch, scope).flatMap((parsed) => parsed.files);
  } catch {
    return [];
  }
}

/**
 * What one edit changed, as on web: the edit's own patch when the server sends one, otherwise
 * the turn's checkpoint diff for the files it touched.
 */
export function FileChangeInlineDiff(props: {
  readonly environmentId: EnvironmentId;
  readonly row: OrchestrationV2ProjectedTurnItem;
}) {
  const { environmentId, row } = props;
  const item = row.item;
  const hasOwnPatch = item.type === "file_change" && item.patchOmitted === true;
  const detail = useTurnItemDetail(hasOwnPatch ? { environmentId, row } : null);
  const fetched = detail.data?.item;
  const ownPatch = fetched?.type === "file_change" ? fetched.patch : undefined;
  const awaitingOwnPatch = hasOwnPatch && detail.isPending && !detail.error;
  const usesCheckpoint = ownPatch === undefined && !awaitingOwnPatch;

  // Only the checkpoint list, and only when it is needed: the whole thread changes on every token.
  const summaries = useAtomValue(
    usesCheckpoint
      ? environmentThreadDetails.checkpointSummariesAtom({
          environmentId,
          threadId: row.sourceThreadId,
        })
      : EMPTY_CHECKPOINT_SUMMARIES_ATOM,
  );
  const summary = summaries.find((candidate) => candidate.runId === item.runId);
  const checkpoint = useCheckpointDiff({
    environmentId: summary ? environmentId : null,
    threadId: summary ? row.sourceThreadId : null,
    fromTurnCount: summary ? Math.max(0, summary.checkpointTurnCount - 1) : null,
    toTurnCount: summary?.checkpointTurnCount ?? null,
    ignoreWhitespace: false,
  });
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const workspaceRoot = selectedThreadCwd ?? undefined;

  const patch = ownPatch ?? (usesCheckpoint ? checkpoint.data?.diff : undefined);
  const files = useMemo(() => {
    if (patch === undefined || item.type !== "file_change") return [];
    const parsed = patchFiles(patch, `inline:${row.sourceItemId}`);
    const matched = [
      ...new Set(
        fileChangeTargetPaths(item).flatMap(
          (path) => findPatchFile(parsed, path, workspaceRoot) ?? [],
        ),
      ),
    ];
    // An edit's own patch holds only its files, so show them even if a path is reported oddly.
    return matched.length > 0 || ownPatch === undefined ? matched : parsed;
  }, [item, patch, ownPatch, row.sourceItemId, workspaceRoot]);

  if (patch === undefined) {
    if (awaitingOwnPatch) return <InlineDiffNote>Loading diff…</InlineDiffNote>;
    if (summary === undefined) {
      return <InlineDiffNote>The diff appears when this turn finishes.</InlineDiffNote>;
    }
    return <InlineDiffNote>{checkpoint.error ? checkpoint.error : "Loading diff…"}</InlineDiffNote>;
  }
  if (files.length === 0) {
    return <InlineDiffNote>No net change to this file by the end of the turn.</InlineDiffNote>;
  }
  return (
    <View className="gap-2 pb-1">
      {files.map((file) => (
        <InlineFileDiff
          key={resolveFileDiffPath(file)}
          environmentId={environmentId}
          threadId={row.sourceThreadId}
          file={file}
          patch={extractFilePatch(patch, file)}
          workspaceRoot={workspaceRoot}
        />
      ))}
    </View>
  );
}

function InlineFileDiff(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: OrchestrationV2ProjectedTurnItem["sourceThreadId"];
  readonly file: FileDiffMetadata;
  readonly patch: string;
  readonly workspaceRoot: string | undefined;
}) {
  const { file, patch } = props;
  const navigation = useNavigation();
  const { nativeReviewDiffStyle, codeWordBreak } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const filePath = resolveFileDiffPath(file);
  // An edit's patch is repo-relative inside the workspace, and absolute outside it.
  const displayPath = workspaceRelativeFilePath(filePath, props.workspaceRoot) ?? filePath;
  const sectionId = `inline:${filePath}`;
  const lineCount = inlineDiffLineCount(file);
  const tooLarge = lineCount > INLINE_DIFF_MAX_LINES;
  const data = useMemo(() => {
    const parsed = buildNativeReviewDiffData(
      buildReviewParsedDiff(tooLarge ? "" : patch, sectionId),
    );
    return { ...parsed, rows: parsed.rows.filter((row) => row.kind !== "file") };
  }, [patch, sectionId, tooLarge]);
  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    return { additions, deletions };
  }, [file]);
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId,
    diff: patch,
    data,
    collapsedFileIds: EMPTY_IDS,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: true,
  });
  const [measured, setMeasured] = useState<{ key: string; height: number } | null>(null);
  const measurementKey = `${patch}:${codeWordBreak}:${nativeReviewDiffStyle.rowHeight}`;
  const [NativeDiff] = useState(() => resolveNativeReviewDiffView());
  const contentHeight =
    measured?.key === measurementKey
      ? measured.height
      : data.rows.length * nativeReviewDiffStyle.rowHeight;
  const openReview = () =>
    navigation.navigate("ThreadReview", {
      environmentId: props.environmentId,
      threadId: props.threadId,
    });

  return (
    <View className="ml-7 overflow-hidden rounded-lg border border-border-subtle">
      <View className="min-h-9 flex-row items-center gap-2 border-b border-border-subtle pl-3 pr-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Review changes to ${displayPath}`}
          onPress={openReview}
          className="min-w-0 flex-1 flex-row items-center gap-2 py-2 active:opacity-60"
        >
          <Text
            className="min-w-0 shrink font-mono text-2xs text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {displayPath}
          </Text>
          <PullRequestDiffStats additions={stats.additions} deletions={stats.deletions} compact />
          <SymbolView name="arrow.up.right" size={12} tintColorClassName="accent-icon-muted" />
        </Pressable>
        {patch.length > 0 ? (
          <CopyTextButton accessibilityLabel="Copy diff" text={patch} iconSize={13} />
        ) : null}
      </View>
      {tooLarge ? (
        <Text className="p-3 text-xs text-foreground-muted">
          {`${lineCount.toLocaleString()} lines is too long to show here.`}
        </Text>
      ) : file.hunks.length === 0 ? (
        <Text className="p-3 text-xs text-foreground-muted">
          {file.type === "rename-pure" ? "Renamed without changes." : "No line changes."}
        </Text>
      ) : NativeDiff && data.rows.length > 0 ? (
        <View style={{ height: Math.min(contentHeight, MAX_CARD_HEIGHT) }}>
          <NativeDiff
            scrollEnabled={contentHeight > MAX_CARD_HEIGHT}
            bounces={false}
            appearanceScheme={themeAppearance}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            contentWidth={2800}
            style={{ flex: 1 }}
            rowsJson={bridge.rowsJson}
            themeJson={bridge.themeJson}
            styleJson={bridge.styleJson}
            tokensPatchJson={bridge.tokensPatchJson}
            tokensResetKey={bridge.tokensResetKey}
            onDebug={(event) => {
              bridge.onDebug(event);
              const { message, contentHeight: height } = event.nativeEvent;
              if (message === "metrics" && typeof height === "number") {
                setMeasured((current) =>
                  current?.key === measurementKey && current.height === height
                    ? current
                    : { key: measurementKey, height },
                );
              }
            }}
            onPressLine={openReview}
          />
        </View>
      ) : (
        <Text selectable className="p-3 font-mono text-2xs leading-normal text-foreground-muted">
          {patch}
        </Text>
      )}
    </View>
  );
}
