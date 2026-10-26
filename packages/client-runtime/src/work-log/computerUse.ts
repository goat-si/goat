import type { OrchestrationV2TurnItem, ToolActivityIcon } from "@goat/contracts";
import {
  computerUseTypedTextLength,
  cuaDriverToolName,
  replaceComputerUseTypedText,
} from "@goat/shared/toolActivity";
import { toolOutputSettle } from "@goat/shared/toolOutput";

import type { WorkLogToolLifecycleStatus } from "./presentation.ts";

export type ComputerUseRunStatus =
  | "running"
  | "succeeded"
  | "unsettled"
  | "failed"
  | "denied"
  | "stopped";

/** A computer-use call as its run card shows it. */
export interface ComputerUseRun {
  readonly tool: string;
  readonly summary: string;
  /** The app or window the call names in its input; an observation names it better in its output. */
  readonly target: string | null;
  /** The call's result is a screenshot by design, so the card shows it without a click. */
  readonly observes: boolean;
  /** How the call names its app, for the app's icon: a bundle id, an app name, or a pid. */
  readonly app: ComputerUseAppRef | null;
}

/** What identifies a call's app well enough to find its icon in the host's app catalog. */
export interface ComputerUseAppRef {
  readonly bundleId?: string;
  readonly name?: string;
  readonly pid?: number;
}

/**
 * The catalog entry a call's app is, matched by bundle id, then by name (case-insensitive); a pid
 * alone matches nothing, since the catalog does not carry pids. Null when nothing matches, so
 * the row keeps its generic icon.
 */
export function computerUseCatalogApp<App extends { readonly id: string; readonly name: string }>(
  ref: ComputerUseAppRef | null,
  catalog: ReadonlyArray<App>,
): App | null {
  if (ref === null) return null;
  if (ref.bundleId !== undefined) {
    const id = ref.bundleId.toLowerCase();
    const byId = catalog.find((app) => app.id.toLowerCase() === id);
    if (byId !== undefined) return byId;
  }
  if (ref.name !== undefined) {
    const name = ref.name.toLowerCase();
    return catalog.find((app) => app.name.toLowerCase() === name) ?? null;
  }
  return null;
}

const APP_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * The icon a computer use row shows for its app, through the same native app icon asset the
 * Codex tool rows use: by bundle id when the call or its observation named one, else by app name.
 * A pid alone, or an id the asset cannot name (an executable path), keeps the generic icon.
 */
export function computerUseAppToolIcon(
  ...refs: ReadonlyArray<ComputerUseAppRef | null>
): Extract<ToolActivityIcon, { readonly _tag: "native-app" }> | undefined {
  for (const ref of refs) {
    const appId = ref?.bundleId;
    if (appId !== undefined && appId.length <= 512 && APP_ID_PATTERN.test(appId))
      return { _tag: "native-app", app: { _tag: "app-id", appId } };
  }
  for (const ref of refs) {
    const displayName = ref?.name;
    if (displayName !== undefined && !/[\\/]/u.test(displayName) && displayName.length <= 160)
      return { _tag: "native-app", app: { _tag: "display-name", displayName } };
  }
  return undefined;
}

/** The app name a row's accessible label adds, from the call or its observation. */
export function computerUseAppName(
  ...refs: ReadonlyArray<ComputerUseAppRef | null>
): string | null {
  for (const ref of refs) if (ref?.name !== undefined) return ref.name;
  for (const ref of refs) if (ref?.bundleId !== undefined) return ref.bundleId;
  return null;
}

/** The app an observation's result names, for a row whose call named only a pid. */
export function computerUseObservedApp(output: unknown): ComputerUseAppRef | null {
  const structured = record(record(output)?.structuredContent) ?? record(output);
  const fields =
    structured?.app_name !== undefined || structured?.bundle_id !== undefined
      ? structured
      : jsonTextFields(output);
  const bundleId = label(fields?.bundle_id, 255);
  const name = label(fields?.app_name, 255);
  if (bundleId === undefined && name === undefined) return null;
  return {
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(name === undefined ? {} : { name }),
  };
}

function inputApp(input: Record<string, unknown>): ComputerUseAppRef | null {
  const bundleId = label(input.bundle_id, 255);
  const name = label(input.name, 255) ?? label(input.app_name, 255);
  const pid = typeof input.pid === "number" && Number.isInteger(input.pid) ? input.pid : undefined;
  if (bundleId === undefined && name === undefined && pid === undefined) return null;
  return {
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(name === undefined ? {} : { name }),
    ...(pid === undefined ? {} : { pid }),
  };
}

const OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  "get_window_state",
  "wait_for_window_settle",
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
  wait_for_window_settle: "Wait for a window to settle",
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
    app: inputApp(input),
  };
}

/** The app and window title an observation's result names. */
export function computerUseObservedTarget(output: unknown): string | null {
  const structured = record(record(output)?.structuredContent) ?? record(output);
  const fields =
    structured?.app_name !== undefined || structured?.window_title !== undefined
      ? structured
      : jsonTextFields(output);
  const app = label(fields?.app_name);
  const title = label(fields?.window_title);
  return app !== undefined && title !== undefined ? `${title} in ${app}` : (app ?? title ?? null);
}

/**
 * GOAT folds a screenshot result's structured fields into a JSON text block, because Codex drops
 * the image beside structuredContent, so an observation's names can arrive that way.
 */
function jsonTextFields(output: unknown): Record<string, unknown> | undefined {
  const blocks = Array.isArray(output) ? output : record(output)?.content;
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    const text = record(block)?.type === "text" ? record(block)?.text : undefined;
    if (typeof text !== "string" || !text.startsWith("{") || text.length > 65_536) continue;
    try {
      const parsed = record(JSON.parse(text));
      if (
        parsed?.app_name !== undefined ||
        parsed?.window_title !== undefined ||
        parsed?.bundle_id !== undefined
      )
        return parsed;
    } catch {
      // Plain text that only looks like JSON.
    }
  }
  return undefined;
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
  unsettled: "Not settled",
  failed: "Failed",
  denied: "Denied",
  stopped: "Stopped",
};

const SETTLE_REASONS: Readonly<Record<string, string>> = {
  private_or_unknown_focus: "focus is private or unknown",
  accessibility_not_granted: "Accessibility access is not granted",
  app_not_approved: "the app is not approved",
  degraded_final_sample: "the final read was incomplete",
};

/**
 * The status a card shows for a finished call, and a note when the result contradicts it: a
 * settle wait completes as a tool call whether or not the window settled (#1585).
 */
export function computerUseResult(
  run: ComputerUseRun | undefined,
  status: ComputerUseRunStatus | null,
  output: unknown,
): { readonly status: ComputerUseRunStatus | null; readonly note: string | null } {
  if (status !== "succeeded" || run?.tool !== "wait_for_window_settle")
    return { status, note: null };
  // The wire keeps the outcome in compact output, so a row that never fetched detail reads it too.
  const settle = toolOutputSettle(output);
  if (settle === undefined || settle.outcome === "settled") return { status, note: null };
  const note =
    settle.outcome === "pending"
      ? "Window did not settle before the deadline"
      : settle.outcome === "destroyed"
        ? "Window closed before it settled"
        : `Window did not settle: ${settleReason(settle.reason) || settle.outcome}`;
  return { status: "unsettled", note };
}

/** A known reason reads as words; a privacy refusal adds the check that failed, as in "(tree children unsupported: AXGroup)". */
function settleReason(reason: string): string {
  const known = SETTLE_REASONS[reason];
  if (known !== undefined) return known;
  const split = reason.indexOf(":");
  const head = split < 0 ? undefined : SETTLE_REASONS[reason.slice(0, split)];
  if (head === undefined) return reason.replaceAll("_", " ");
  const detail = reason
    .slice(split + 1)
    .split(",")
    // "seen:" entries summarize the helper's reads for diagnosis; the card shows only the problems.
    .filter((problem) => !problem.startsWith("seen:"))
    .map((problem) => {
      const [check = "", ...names] = problem.split(":");
      return [check.replaceAll("_", " "), ...names].join(": ");
    })
    .join("; ");
  return `${head} (${detail})`;
}

/**
 * A card's status from its row: the wire item's compact output keeps the settle outcome even when
 * fetched detail was cut at its byte limit, so it is read first and the detail only fills a gap.
 */
export function computerUseItemResult(
  run: ComputerUseRun | undefined,
  status: ComputerUseRunStatus | null,
  wireOutput: unknown,
  fetchedOutput: unknown,
): { readonly status: ComputerUseRunStatus | null; readonly note: string | null } {
  const fromWire = computerUseResult(run, status, wireOutput);
  return fromWire.note !== null || fetchedOutput === undefined
    ? fromWire
    : computerUseResult(run, status, fetchedOutput);
}

/**
 * Whether a card must fetch detail for its status even with screenshots hidden: a settle row whose
 * wire output carries no outcome, as from a server before compact settle outcomes.
 */
export function computerUseNeedsResultDetail(
  run: ComputerUseRun | undefined,
  wireOutput: unknown,
): boolean {
  return run?.tool === "wait_for_window_settle" && toolOutputSettle(wireOutput) === undefined;
}
