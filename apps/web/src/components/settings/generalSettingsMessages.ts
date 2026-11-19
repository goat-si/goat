import { msg } from "gt-react";
import type {
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
