import type { OrchestrationV2TurnItem } from "@goat/contracts";
import {
  computerUseTypedTextLength,
  cuaDriverToolName,
  replaceComputerUseTypedText,
} from "@goat/shared/toolActivity";

import type { WorkLogToolLifecycleStatus } from "./presentation.ts";

export type ComputerUseRunStatus = "running" | "succeeded" | "failed" | "denied" | "stopped";

/** A computer-use call as its run card shows it. */
export interface ComputerUseRun {
  readonly tool: string;
  readonly summary: string;
  /** The app or window the call names in its input; an observation names it better in its output. */
  readonly target: string | null;
  /** The call's result is a screenshot by design, so the card shows it without a click. */
  readonly observes: boolean;
}

const OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "get_window_state",
  "get_desktop_state",
  "zoom",
  "verify_state",
]);

const SUMMARIES: Readonly<Record<string, string>> = {
  click: "Click",
  double_click: "Double-click",
  right_click: "Right-click",
  drag: "Drag",
  move_cursor: "Move the pointer",
  set_value: "Set a value",
  invoke_menu: "Choose a menu item",
  bring_to_front: "Bring a window to the front",
  set_window_frame: "Move a window",
  get_window_state: "Look at a window",
  get_desktop_state: "Look at the desktop",
  zoom: "Zoom in",
  verify_state: "Check a window",
  list_apps: "List apps",
  list_windows: "List windows",
  get_accessibility_tree: "Read the accessibility tree",
  get_screen_size: "Read the screen size",
  get_cursor_position: "Read the pointer position",
  check_permissions: "Check permissions",
  run_steps: "Run steps",
  run_script: "Run a script",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function label(value: unknown, max = 60): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function keys(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? value.flatMap((key) => label(key, 20) ?? []) : [];
}

const characters = (length: number) => `${length} character${length === 1 ? "" : "s"}`;

/**
 * A computer-use call's input with its typed text replaced by the text's length. The text can be
 * a password, so the expanded row, its copy text and every client show only how long it was. The
 * server sends a redacted marker; raw text from a server that did not redact gets the same label.
 */
export function computerUseDisplayInput(
  toolName: string | null | undefined,
  input: unknown,
): unknown {
  return replaceComputerUseTypedText(toolName, input, characters);
}

function summary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "click":
    case "double_click":
    case "right_click": {
      const verb = SUMMARIES[tool];
      const element = label(input.element_index);
      if (element !== undefined) return `${verb} element ${element}`;
      const x = label(input.x);
      const y = label(input.y);
      return x !== undefined && y !== undefined ? `${verb} at ${x}, ${y}` : `${verb}`;
    }
    case "type_text": {
      // Typed text can be a password, so the card shows only how long it was.
      const length = computerUseTypedTextLength("cua-driver.type_text", input) ?? 0;
      return length === 0 ? "Type text" : `Type ${characters(length)}`;
    }
    case "press_key": {
      const key = label(input.key, 20);
      return key === undefined
        ? "Press a key"
        : `Press ${[...keys(input.modifiers), key].join("+")}`;
    }
    case "hotkey": {
      const combo = keys(input.keys);
      return combo.length === 0 ? "Press a shortcut" : `Press ${combo.join("+")}`;
    }
    case "scroll": {
      const direction = label(input.direction, 10);
      return direction === undefined ? "Scroll" : `Scroll ${direction}`;
    }
    case "launch_app":
      return `Open ${label(input.name) ?? label(input.bundle_id) ?? "an app"}`;
    default:
      return SUMMARIES[tool] ?? tool.replaceAll("_", " ");
  }
}

function inputTarget(input: Record<string, unknown>): string | null {
  const app = label(input.name) ?? label(input.bundle_id);
  if (app !== undefined) return app;
  const pid = label(input.pid, 12);
  if (pid === undefined) return null;
  const window = label(input.window_id, 12);
  return window === undefined ? `Process ${pid}` : `Process ${pid}, window ${window}`;
}

export function computerUseRun(
  item: OrchestrationV2TurnItem | undefined,
): ComputerUseRun | undefined {
  if (item?.type !== "dynamic_tool") return undefined;
  const tool = cuaDriverToolName(item.toolName);
  if (tool === undefined) return undefined;
  const raw = record(item.input);
  // ACP children keep the call in its {server, tool, arguments} envelope.
  const input = (raw?.server === "cua-driver" ? record(raw.arguments) : raw) ?? {};
  return {
    tool,
    summary: summary(tool, input),
    target: inputTarget(input),
    observes: OBSERVATION_TOOLS.has(tool),
  };
}

/** The app and window title an observation's result names. */
export function computerUseObservedTarget(output: unknown): string | null {
  const structured = record(record(output)?.structuredContent) ?? record(output);
  const app = label(structured?.app_name);
  const title = label(structured?.window_title);
  return app !== undefined && title !== undefined ? `${title} in ${app}` : (app ?? title ?? null);
}

export function computerUseRunStatus(
  status: WorkLogToolLifecycleStatus | undefined,
): ComputerUseRunStatus | null {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "declined":
      return "denied";
    case "stopped":
      return "stopped";
    default:
      return null;
  }
}

export const COMPUTER_USE_RUN_STATUS_LABELS: Readonly<Record<ComputerUseRunStatus, string>> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  denied: "Denied",
  stopped: "Stopped",
};
