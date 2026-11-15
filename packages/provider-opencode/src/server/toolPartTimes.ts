import type { ToolPart } from "@opencode-ai/sdk/v2";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export function dateTimeFromEpoch(value: number | undefined, fallback: DateTime.Utc): DateTime.Utc {
  if (value === undefined) return fallback;
  return Option.getOrElse(DateTime.make(value), () => fallback);
}

export function toolInput(part: ToolPart): Record<string, unknown> {
  return part.state.input;
}

export function toolStartedAt(part: ToolPart, now: DateTime.Utc): DateTime.Utc {
  return dateTimeFromEpoch(
    part.state.status === "pending" ? undefined : part.state.time.start,
    now,
  );
}

export function toolCompletedAt(part: ToolPart, now: DateTime.Utc): DateTime.Utc | null {
  return part.state.status === "completed" || part.state.status === "error"
    ? dateTimeFromEpoch(part.state.time.end, now)
    : null;
}
