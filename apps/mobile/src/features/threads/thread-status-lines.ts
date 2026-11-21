import type { FloatingStatusAction } from "./floating-working-status";
import type { ThreadStatusLineModel } from "./thread-status-line";

export function threadStatusLines(input: {
  readonly background: null | {
    readonly title: string;
    readonly waiting: boolean;
    readonly accessibilityLabel: string;
    readonly onOpen: () => void;
    readonly action: FloatingStatusAction;
  };
  readonly lifecycle: null | {
    readonly state: "snoozed" | "settled" | "woke";
    readonly label: string;
    readonly action: FloatingStatusAction;
  };
}): ReadonlyArray<ThreadStatusLineModel> {
  const lines: ThreadStatusLineModel[] = [];
  if (input.background)
    lines.push({
      key: "background",
      icon: input.background.waiting ? "person.2" : "terminal",
      label: input.background.title,
      accessibilityLabel: input.background.accessibilityLabel,
      onOpen: input.background.onOpen,
      action: input.background.action,
    });
  if (input.lifecycle)
    lines.push({
      key: "lifecycle",
      icon: input.lifecycle.state === "settled" ? "checkmark.circle" : "clock",
      label: input.lifecycle.label,
      action: input.lifecycle.action,
    });
  return lines;
}
