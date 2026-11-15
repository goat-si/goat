import { commandDisplayText } from "@goat/client-runtime/work-log/command-label";
import {
  commandVerb,
  formatCommandActionsLabel,
  liveActivityToolStatus,
  resolveWorkEntryToolPresentation,
  toolGroupAction,
  workEntryCommandActions,
  type WorkLogPresentationEntry,
} from "@goat/client-runtime/work-log/presentation";
import { workspaceRelativeFilePath } from "@goat/shared/path";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@goat/shared/toolActivity";
import { truncate } from "@goat/shared/String";

/** Long Android headers can ANR despite one-line display; cap labels only, preserving expanded and copied text. */
export const WORK_LOG_LABEL_MAX_LENGTH = 200;

export function compactWorkEntryText(value: string): string {
  return truncate(value.replace(/\s+/gu, " "), WORK_LOG_LABEL_MAX_LENGTH);
}

/** Absolute paths (Codex resolves reads against the cwd) shrink to the file name. */
export function compactCommandActionPath(path: string): string {
  return /^(?:\/|[A-Za-z]:[\\/])/u.test(path)
    ? (path.split(/[\\/]/u).findLast((part) => part.length > 0) ?? path)
    : path;
}

export function commandActionsRowLabel(entry: WorkLogPresentationEntry): string | null {
  const commandActions = workEntryCommandActions(entry);
  return commandActions
    ? formatCommandActionsLabel(commandActions, {
        active: entry.toolLifecycleStatus === "inProgress",
        formatPath: compactCommandActionPath,
      })
    : null;
}

/**
 * A label that repeats a provider path shows that path relative to the thread workspace.
 * Paths outside the workspace stay as the provider reported them.
 */
export function relativizeWorkLabelPaths(
  label: string,
  paths: readonly string[] | undefined,
  workspaceRoot: string | null | undefined,
): string {
  if (!workspaceRoot || paths === undefined || paths.length === 0) return label;
  const replacements = paths
    .flatMap((path) => {
      const relative = workspaceRelativeFilePath(path, workspaceRoot);
      return relative !== null && relative !== path ? [{ path, relative }] : [];
    })
    .sort((left, right) => right.path.length - left.path.length);
  let next = label;
  for (const { path, relative } of replacements) {
    if (next.includes(path)) next = next.replaceAll(path, relative);
  }
  return next;
}

/** Expanded work rows keep their detail while compact rows show a stable one-line label. */
export function workEntryRowLabel(
  entry: WorkLogPresentationEntry,
  expanded = false,
  workspaceRoot?: string | null,
): string {
  if (entry.itemType === "fork") return entry.label;
  // A provider retry row shows its retry state; the failure message opens with the row.
  if (entry.structuredPayload?.type === "error" && entry.structuredPayload.retry !== undefined)
    return expanded ? (entry.detail ?? entry.label) : entry.label;
  if (expanded && entry.itemType === "reasoning")
    return entry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  // Expanded, an inspecting command shows the command it ran.
  const commandActionsLabel = expanded ? null : commandActionsRowLabel(entry);
  if (commandActionsLabel) return commandActionsLabel;
  if (entry.command?.trim()) {
    const verb = commandVerb(liveActivityToolStatus(entry.toolLifecycleStatus, false));
    return compactWorkEntryText(`${verb} ${commandDisplayText(entry.command)}`);
  }
  const action = toolGroupAction(entry);
  const isToolRead = action === "read" && entry.itemType === "dynamic_tool";
  if (action === "code-search" || action === "search") {
    const toolData =
      entry.toolData !== null &&
      typeof entry.toolData === "object" &&
      !Array.isArray(entry.toolData)
        ? (entry.toolData as Record<string, unknown>)
        : undefined;
    const searchLabel =
      entry.itemType === "file_search" ? entry.label : formatSearchToolLabel(toolData);
    if (searchLabel) return searchLabel;
  }
  if (isToolRead) {
    const [firstPath] = entry.changedFiles ?? collectToolFilePaths(entry.toolData);
    if (firstPath) {
      return formatReadToolLabel(firstPath, Math.max(0, (entry.changedFiles?.length ?? 1) - 1));
    }
    if (!expanded) return "Read file";
  }
  const changedFiles = entry.changedFiles ?? [];
  const [firstChangedFile] = changedFiles;
  const firstChangedLabel =
    firstChangedFile === undefined
      ? null
      : (workspaceRelativeFilePath(firstChangedFile, workspaceRoot) ?? firstChangedFile);
  const preview =
    entry.command ??
    (isToolRead || (!expanded && (action === "code-search" || action === "search"))
      ? null
      : entry.detail) ??
    (firstChangedLabel === null
      ? null
      : changedFiles.length === 1
        ? firstChangedLabel
        : `${firstChangedLabel} +${changedFiles.length - 1} more`);
  const label = expanded
    ? preview?.trim()
      ? truncate(preview, WORK_LOG_LABEL_MAX_LENGTH)
      : entry.label
    : preview
      ? compactWorkEntryText(preview) || entry.label
      : entry.label;
  return relativizeWorkLabelPaths(label, entry.changedFiles, workspaceRoot);
}
