import { msg } from "gt-react";
import { IDLE_COMPACTION_MODES } from "@goat/contracts/settings";
import type {
  IdleCompactionMode,
  QuitConfirmationMode,
  ResponseStreamingMode,
  SidebarProjectSortOrder,
} from "@goat/contracts/settings";

export const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: msg("Wait for the full response"),
  paragraph: msg("Show finished paragraphs"),
};

export const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: msg("Text appears once the agent finishes its turn."),
  paragraph: msg("Each paragraph or code block appears as soon as it is complete."),
};

export const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: msg("Last user message"),
  created_at: msg("Created at"),
  manual: msg("Manual"),
};

export const TIMESTAMP_FORMAT_LABELS = {
  locale: msg("System default"),
  "12-hour": msg("12-hour"),
  "24-hour": msg("24-hour"),
};

export const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: msg("Direct"),
  hold: msg("Hold"),
  "double-click": msg("Double press"),
};

export const IDLE_COMPACTION_LABELS: Record<IdleCompactionMode, string> = {
  onReturn: msg("When you return"),
  beforeCacheExpires: msg("Before the cache expires (beta)"),
  off: msg("Never"),
};

export function idleCompactionLabel(value: string): string {
  const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
  return mode ? IDLE_COMPACTION_LABELS[mode.value] : "";
}
