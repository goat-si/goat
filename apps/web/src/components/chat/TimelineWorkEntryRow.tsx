import { WorkLogDetails, WorkLogRow } from "./WorkLog";
import {
  getQuestionAnswerPreview,
  getQuestionAnswerText,
  getQuestionAnswerAttribution,
  getQuestionTextPreview,
  hasQuestionAnswer,
} from "@goat/client-runtime/work-log/user-input";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { notificationChildThreadId } from "@goat/client-runtime/state/thread-execution";
import {
  resolveViewedImageAsset,
  workEntryViewedImagePath,
} from "@goat/client-runtime/work-log/presentation";
import {
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
} from "@goat/client-runtime/work-log/item-detail";
import { computerUseRun, computerUseRunStatus } from "@goat/client-runtime/work-log/computer-use";
import { claudeSkillInvocation } from "@goat/shared/toolActivity";
import { memo, use, useState, type KeyboardEvent } from "react";
import {
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import { ChevronRightIcon, CircleAlertIcon, XIcon, RotateCcwIcon } from "~/components/solar";
import { Button, InlineButton } from "../ui/button";
import { useAssetUrls } from "../../assets/assetUrls";
import { useThreadShell } from "../../state/entities";
import {
  threadReadLabelPrefix,
  threadReadTargetId,
  threadReadTargetTitle,
  toolGroupAction,
  workEntryDisplayLabel,
  workEntryReadOutput,
} from "./MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { FetchedToolOutput, V2ItemInspector, fileChangeDiffTarget } from "./V2ItemInspector";
import { FileChangeInlineDiff } from "./FileChangeInlineDiff";
import { ComputerUseRunCard } from "./ComputerUseRunCard";
import { fileChangeTargetPaths } from "@goat/client-runtime/work-log/file-change-diff";
import { fileChangeRowLabel } from "./fileChangeInlineDiff.logic";
import { fileChangeLineCounts } from "@goat/client-runtime/work-log/line-counts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DiffStatLabel } from "./DiffStatLabel";
import type { WorkLogLineCounts } from "@goat/client-runtime/work-log/line-counts";
import { SubagentNotificationLink } from "./V2LifecycleRow";
import {
  TimelineRowCtx,
  TimelineRowActivityCtx,
  WorkGroupViewCtx,
  type TimelineWorkEntry,
} from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, TimelineRowTimestamp } from "./TimelineRowParts";
import {
  failedToolIconClassName,
  toolIconAcceptsTint,
  ToolActivityIconView,
} from "./TimelineToolActivityIcon";
import {
  workToneIcon,
  workEntryRawCommand,
  buildToolCallExpandedBody,
  workEntryIconName,
  remarkThoughtPreview,
} from "./TimelineWorkEntryRow.logic";

export function useThreadReadTarget(entry: TimelineWorkEntry, environmentId: EnvironmentId) {
  const rawThreadId = threadReadTargetId(entry);
  const threadId = rawThreadId === null ? null : ThreadId.make(rawThreadId);
  const shell = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const title = threadReadTargetTitle(shell);
  return threadId && title ? { threadId, title } : null;
}

export function threadReadLabel(label: string, target: ReturnType<typeof useThreadReadTarget>) {
  const prefix = target && threadReadLabelPrefix(label);
  return prefix ? { ...target, prefix, text: `${prefix} “${target.title}”` } : null;
}

export function ThreadReadLabel({
  label,
  environmentId,
  linked,
}: {
  label: NonNullable<ReturnType<typeof threadReadLabel>>;
  environmentId: EnvironmentId;
  linked: boolean;
}) {
  return (
    <span className="flex min-w-0">
      <span className="shrink-0">{label.prefix} “</span>
      {linked ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: label.threadId }}
          className="min-w-0 truncate rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={stopRowToggle}
          onKeyDown={stopRowToggle}
        >
          {label.title}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{label.title}</span>
      )}
      <span className="shrink-0">”</span>
    </span>
  );
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function ReasoningTraceContent({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const ctx = use(TimelineRowCtx);
  const { isWorking, latestRunId } = use(TimelineRowActivityCtx);
  const isStreaming = (entry: TimelineWorkEntry) =>
    isWorking && entry.runId === latestRunId && entry.toolLifecycleStatus === "inProgress";
  return (
    <WorkLogDetails followLive={entries.some(isStreaming)}>
      {entries.map((entry) => (
        <ChatMarkdown
          key={entry.id}
          className="text-work-log text-secondary-label"
          text={entry.detail ?? ""}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          isStreaming={isStreaming(entry)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onUseArtifactTemplate={ctx.onUseArtifactTemplate}
          onImageExpand={ctx.onImageExpand}
          lineBreaks
        />
      ))}
    </WorkLogDetails>
  );
}

type WorkEntryRowProps = {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
};

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {
  const ctx = use(TimelineRowCtx);
  const item = props.workEntry.projectedItem?.item;
  const childThreadId =
    item?.type === "notification" ? notificationChildThreadId(item.source) : undefined;
  if (item?.type !== "notification" || childThreadId === undefined) {
    return <WorkEntryLogRow {...props} />;
  }
  return (
    <SubagentNotificationLink
      parentRef={scopeThreadRef(ctx.activeThreadEnvironmentId, item.threadId)}
      childThreadId={childThreadId}
      outcome={item.outcome}
      createdAt={props.workEntry.createdAt}
      timestampFormat={ctx.timestampFormat}
      onOpenThread={ctx.onOpenThread}
      fallback={<WorkEntryLogRow {...props} />}
    />
  );
});

function WorkEntryLogRow(props: WorkEntryRowProps) {
  const { workEntry, workspaceRoot, displayLabel } = props;
  const ctx = use(TimelineRowCtx);
  const { threadRef, onImageExpand, timestampFormat } = ctx;
  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;
  const threadTarget = useThreadReadTarget(workEntry, ctx.activeThreadEnvironmentId);
  const createdThread =
    workEntry.projectedItem?.item.type === "thread_created"
      ? workEntry.projectedItem.item
      : undefined;
  const notifiedSubagentThreadId =
    workEntry.projectedItem?.item.type === "notification"
      ? notificationChildThreadId(workEntry.projectedItem.item.source)
      : undefined;
  const groupView = use(WorkGroupViewCtx);
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry(!next);
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    } else {
      props.onToggleEntry?.(!next);
    }
    setExpanded(next);
  };
  const failureItem = workEntry.projectedItem?.item;
  if (failureItem?.type === "error" && failureItem.status === "failed") {
    const warning = failureItem.failure.class === "usage_limit";
    const resetAt = failureItem.failure.resetAt;
    const resetTime = resetAt ? formatUpcomingTimestamp(resetAt, timestampFormat) : null;
    const label = warning
      ? `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`
      : workEntry.label;
    const retryRunId =
      failureItem.runId !== null &&
      retryableWorkspacePreparationRunIds.has(failureItem.runId) &&
      failureItem.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
        ? failureItem.runId
        : null;
    return (
      <WorkLogRow
        data-v2-item-type="error"
        data-v2-item-visibility={workEntry.projectedItem?.visibility}
        wrapLabel
        icon={
          <CircleAlertIcon
            className={cn("size-4", warning ? "text-warning" : "text-destructive")}
          />
        }
        label={
          <span
            className={cn("text-sm font-medium", warning ? "text-warning" : "text-destructive")}
          >
            {label}
          </span>
        }
        trailing={
          <TimelineRowTimestamp
            createdAt={workEntry.createdAt}
            timestampFormat={timestampFormat}
            alwaysVisible
          />
        }
      >
        {!warning ? (
          <p className="ms-7 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
            {failureItem.failure.message}
          </p>
        ) : null}
        {failureItem.failure.log ? (
          <details className="ms-7 pb-1 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm -outline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              Show log
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 font-mono text-xs">
              {failureItem.failure.log}
            </pre>
          </details>
        ) : null}
        {retryRunId !== null && onRetryWorkspacePreparation ? (
          <div className="ms-7 pb-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onRetryWorkspacePreparation(retryRunId)}
            >
              <RotateCcwIcon aria-hidden />
              Retry
            </Button>
          </div>
        ) : null}
      </WorkLogRow>
    );
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator =
    !showWarningIndicator && workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    !showWarningIndicator &&
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon =
    showWarningIndicator || showDestructiveRowStyle
      ? undefined
      : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  const isReasoning = workEntry.itemType === "reasoning";
  const computerUse = computerUseRun(workEntry.projectedItem?.item);
  const questionHeading = workEntry.questionAnswer
    ? getQuestionTextPreview(workEntry.questionAnswer)
    : "";
  const previewText =
    isReasoning && expanded
      ? workEntry.toolLifecycleStatus === "inProgress"
        ? "Thinking"
        : "Thought"
      : questionHeading ||
        (computerUse?.summary ??
          displayLabel ??
          // Like Codex: verb and file name; the tooltip keeps every full path.
          (workEntry.projectedItem?.item.type === "file_change"
            ? fileChangeRowLabel(workEntry.projectedItem.item)
            : workEntryDisplayLabel(workEntry, workspaceRoot)));
  const answerPreview =
    workEntry.questionAnswer && hasQuestionAnswer(workEntry.questionAnswer)
      ? getQuestionAnswerPreview(workEntry.questionAnswer)
      : null;
  const lineCounts = fileChangeLineCounts(workEntry.structuredPayload);
  const projectedFileChange =
    workEntry.projectedItem?.item.type === "file_change" ? workEntry.projectedItem.item : null;
  // A failed edit keeps the inspector: its diffStr holds the provider's error.
  const inlineDiffRunId =
    projectedFileChange !== null && projectedFileChange.status !== "failed" && threadRef
      ? projectedFileChange.runId
      : null;
  // Expanded edit rows carry Open diff themselves, so the inspector below skips its summary.
  const fileChangeDiff =
    expanded && workEntry.projectedItem ? fileChangeDiffTarget(workEntry.projectedItem) : null;
  // The label truncates and "+N more" hides the rest; the tooltip names every edited file.
  const tooltipPaths =
    workEntry.changedFiles !== undefined && workEntry.changedFiles.length > 0
      ? workEntry.changedFiles
      : projectedFileChange !== null
        ? fileChangeTargetPaths(projectedFileChange)
        : [];
  const changedFilesTooltip =
    tooltipPaths.length > 0
      ? tooltipPaths.map((path) => formatWorkspaceRelativePath(path, workspaceRoot)).join("\n")
      : null;
  const viewedImagePath = workEntryViewedImagePath(workEntry);
  const payload = workEntry.structuredPayload;
  const skill =
    payload?.type === "dynamic_tool"
      ? claudeSkillInvocation(payload.toolName, payload.input)
      : undefined;
  // Commands that read files keep the inspector so their command and output stay visible.
  const plainOutput =
    toolGroupAction(workEntry) === "read" && workEntry.itemType !== "command_execution"
      ? workEntryReadOutput(workEntry, workspaceRoot)
      : skill
        ? (skill.args ?? null)
        : undefined;
  const viewedImage =
    viewedImagePath && threadRef
      ? resolveViewedImageAsset(viewedImagePath, {
          threadId: threadRef.threadId,
          workspaceRoot,
        })
      : null;
  const canExpand =
    previewText.trim().length > 0 ||
    (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) ||
    Boolean(
      workEntryRawCommand(workEntry) ||
      workEntry.command?.trim() ||
      workEntry.detail?.trim() ||
      workEntry.changedFiles?.length ||
      viewedImage,
    );
  const expandedBody =
    expanded && !isReasoning
      ? plainOutput !== undefined
        ? plainOutput
        : buildToolCallExpandedBody(
            workEntry,
            workspaceRoot,
            previewText,
            viewedImage ? viewedImagePath : null,
          )
      : null;
  const plainOutputFetches =
    plainOutput !== undefined &&
    workEntry.projectedItem !== undefined &&
    turnItemNeedsDetailFetch(workEntry.projectedItem.item);
  const canExpandProjectedItem =
    plainOutput !== undefined
      ? Boolean(plainOutput || viewedImage || workEntry.questionAnswer || plainOutputFetches)
      : workEntry.projectedItem === undefined
        ? canExpand
        : isReasoning
          ? Boolean(workEntry.detail?.trim())
          : Boolean(
              viewedImage ||
              workEntry.questionAnswer ||
              turnItemHasDetail(workEntry.projectedItem.item),
            );
  const iconWrapperClass = cn(
    "flex size-4 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-icon-muted"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : isReasoning || workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label/85"
        : "text-foreground/80";
  const threadLabel = isReasoning ? null : threadReadLabel(previewText, threadTarget);
  const labelClassName = cn(
    answerPreview || lineCounts ? "min-w-0" : "min-w-0 flex-1",
    "truncate",
    headingClass,
  );
  const accessiblePreview = [
    threadLabel?.text ?? previewText,
    answerPreview,
    lineCounts ? lineCountsAccessibleText(lineCounts) : null,
  ]
    .filter(Boolean)
    .join(": ");
  const accessibleDisplayText = showFailedIndicator
    ? `${accessiblePreview}, tool call failed`
    : accessiblePreview;
  const rowToggleProps = canExpandProjectedItem
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <WorkLogRow
      data-v2-item-type={workEntry.projectedItem?.item.type}
      data-v2-item-visibility={workEntry.projectedItem?.visibility}
      {...rowToggleProps}
      icon={
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-4 shrink-0 stroke-2"
            muted
          />
        </span>
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="flex min-w-0 w-full items-baseline gap-1.5 text-work-log">
            {changedFilesTooltip !== null && !isReasoning && threadLabel === null ? (
              <Tooltip>
                <TooltipTrigger render={<span className={labelClassName} />}>
                  {previewText}
                </TooltipTrigger>
                <TooltipPopup className="whitespace-pre-line">{changedFilesTooltip}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className={labelClassName}>
                {isReasoning && !expanded ? (
                  <ChatMarkdown
                    inline
                    text={workEntry.detail ?? previewText}
                    cwd={ctx.markdownCwd}
                    parseRawHtml={false}
                    extraRemarkPlugins={[
                      [
                        remarkThoughtPreview,
                        workEntry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought",
                      ],
                    ]}
                  />
                ) : threadLabel ? (
                  <ThreadReadLabel
                    label={threadLabel}
                    environmentId={ctx.activeThreadEnvironmentId}
                    linked
                  />
                ) : (
                  previewText
                )}
              </span>
            )}
            {answerPreview ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  !expanded &&
                    workEntry.questionAnswer &&
                    hasQuestionAnswer(workEntry.questionAnswer)
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {answerPreview}
              </span>
            ) : null}
            {lineCounts ? <WorkLogLineCountsLabel counts={lineCounts} /> : null}
          </p>
        </div>
      }
      trailing={
        <>
          {createdThread ? (
            <button
              type="button"
              className="shrink-0 rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={`Open ${createdThread.title ?? "created thread"}`}
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(createdThread.targetThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open chat
            </button>
          ) : null}
          {notifiedSubagentThreadId ? (
            <InlineButton
              aria-label="Open subagent thread"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(notifiedSubagentThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open subagent
            </InlineButton>
          ) : null}
          {fileChangeDiff !== null ? (
            <InlineButton
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenTurnDiff(
                  fileChangeDiff.runId,
                  fileChangeDiff.filePath,
                  fileChangeDiff.sourceItem,
                );
              }}
              onKeyDown={stopRowToggle}
            >
              Open diff
            </InlineButton>
          ) : null}
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpandProjectedItem && "invisible",
            )}
            aria-hidden
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </>
      }
    >
      {computerUse && workEntry.projectedItem && (expanded || computerUse.observes) ? (
        // Expanded, the inspector below shows the screenshots with the rest of the output.
        <ComputerUseRunCard
          run={computerUse}
          status={computerUseRunStatus(workEntry.toolLifecycleStatus)}
          projectedItem={workEntry.projectedItem}
          environmentId={ctx.activeThreadEnvironmentId}
          showScreenshots={!expanded}
          onImageExpand={onImageExpand}
        />
      ) : null}
      {expanded && viewedImage && threadRef ? (
        <WorkLogDetails kind="media">
          <ChatMarkdownAssetImage
            environmentId={threadRef.environmentId}
            resource={viewedImage.resource}
            alt={viewedImage.alt}
            srcFragment={viewedImage.srcFragment}
            workspaceRoot={workspaceRoot}
            maxHeightRem={16}
            onImageExpand={onImageExpand}
          />
        </WorkLogDetails>
      ) : null}
      {expanded && workEntry.questionAnswer ? (
        <QuestionAnswerHistory answer={workEntry.questionAnswer} />
      ) : null}
      {expanded && isReasoning ? <ReasoningTraceContent entries={[workEntry]} /> : null}
      {expanded &&
      inlineDiffRunId !== null &&
      projectedFileChange !== null &&
      workEntry.projectedItem &&
      threadRef ? (
        <WorkLogDetails kind="panel">
          <FileChangeInlineDiff
            threadRef={threadRef}
            projectedItem={workEntry.projectedItem}
            runId={inlineDiffRunId}
            workspaceRoot={workspaceRoot}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        </WorkLogDetails>
      ) : null}
      {expanded &&
      !isReasoning &&
      !workEntry.questionAnswer &&
      inlineDiffRunId === null &&
      canExpandProjectedItem &&
      (expandedBody ||
        plainOutputFetches ||
        (workEntry.projectedItem && plainOutput === undefined)) ? (
        <WorkLogDetails kind="panel">
          {workEntry.projectedItem && plainOutput === undefined ? (
            <V2ItemInspector
              projectedItem={workEntry.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={workspaceRoot}
              onOpenThread={ctx.onOpenThread}
              onOpenTurnDiff={ctx.onOpenTurnDiff}
              onRollbackCheckpoint={ctx.onRollbackCheckpoint}
              onImageExpand={ctx.onImageExpand}
              hideFileChangeSummary
            />
          ) : (
            <>
              {expandedBody ? (
                <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
              ) : null}
              {plainOutputFetches && workEntry.projectedItem ? (
                <FetchedToolOutput
                  projectedItem={workEntry.projectedItem}
                  environmentId={ctx.activeThreadEnvironmentId}
                  onImageExpand={onImageExpand}
                />
              ) : null}
            </>
          )}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

function QuestionAnswerHistory({
  answer,
}: {
  answer: import("@goat/contracts").UserInputAttachmentAnswerPayload;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const attachments = Object.values(answer.attachmentsByQuestionId).flat();
  const resources = attachments.map((attachment) => ({
    _tag: "attachment" as const,
    attachmentId: attachment.id,
  }));
  const urls = useAssetUrls(activeThreadEnvironmentId, resources);
  const attribution = getQuestionAnswerAttribution(answer);
  return (
    <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
      {attribution === null ? null : (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {attribution}
        </p>
      )}
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p className="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {getQuestionAnswerText(answer.answers[questionId])}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => {
              const url = urls[attachments.indexOf(attachment)];
              return (
                <a
                  key={attachment.id}
                  href={url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  {attachment.type === "image" && url ? (
                    <img
                      src={url}
                      alt={attachment.name}
                      className="h-20 max-w-32 rounded object-contain"
                    />
                  ) : (
                    attachment.name
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function lineCountsAccessibleText(counts: WorkLogLineCounts): string {
  return `${counts.additions} ${counts.additions === 1 ? "line" : "lines"} added, ${counts.deletions} removed`;
}

/** Added and removed line counts beside an edit's file name. */
export function WorkLogLineCountsLabel({ counts }: { counts: WorkLogLineCounts }) {
  return (
    <DiffStatLabel
      additions={counts.additions}
      deletions={counts.deletions}
      layout="inline"
      className="shrink-0 text-xs"
    />
  );
}
