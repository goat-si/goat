import type { ThreadFeedActivity } from "./threadActivityTypes";
import { commandProgramName } from "@goat/client-runtime/work-log/command-label";
import {
  commandVerb,
  liveActivityToolStatus,
  resolveWorkEntryToolPresentation,
  workEntryCommandActions,
  formatCommandActionsLabel,
} from "@goat/client-runtime/work-log/presentation";
import { compactCommandActionPath, compactWorkEntryText } from "./workEntryRowLabel";

export function liveToolActivitySummary(
  activity: ThreadFeedActivity,
  presentTense: boolean,
): string {
  const status = liveActivityToolStatus(activity.lifecycleStatus, presentTense);
  if (activity.workEntry.itemType === "reasoning") {
    return compactWorkEntryText(
      activity.workEntry.detail?.trim() || (status === "inProgress" ? "Thinking" : "Thought"),
    );
  }
  const presentation = resolveWorkEntryToolPresentation({
    ...activity.workEntry,
    toolLifecycleStatus: status,
  });
  if (presentation) return presentation.displayName;
  const commandActions = workEntryCommandActions(activity.workEntry);
  if (commandActions) {
    return formatCommandActionsLabel(commandActions, {
      active: status === "inProgress",
      formatPath: compactCommandActionPath,
    });
  }
  const command = activity.workEntry.command?.trim();
  if (command) {
    return `${commandVerb(status)} ${commandProgramName(command) ?? "command"}`;
  }
  return compactWorkEntryText(activity.detail ?? activity.summary);
}
