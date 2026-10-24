import {
  type ComputerUseReadiness,
  type ComputerUseRefusal,
  type ComputerUseRefusalReason,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

import type { DriverWindowState } from "./computerUseObservation.ts";

/**
 * What GOAT Computer Use.exe (apps/desktop/native/computer-use-helper-windows) knows that the
 * driver does not, turned into protocol terms: which window an epoch names, whether a password
 * field has focus, whether the target is reachable at all, and how ready this desktop is.
 */

/** The helper's answer to window: one window's identity and admission facts. */
export const WindowsWindowFacts = Schema.Struct({
  exists: Schema.Boolean,
  ownerPid: Schema.optionalKey(Schema.Number),
  ownerMatches: Schema.optionalKey(Schema.Boolean),
  sameSession: Schema.optionalKey(Schema.Boolean),
  /** Window handle, virtual desktop, monitor and DPI; any change invalidates every ref. */
  epoch: Schema.optionalKey(Schema.String),
  elevatedTarget: Schema.optionalKey(Schema.Boolean),
  inputDesktop: Schema.optionalKey(Schema.String),
  /** secure: a password field of this process has keyboard focus. unknown: UIA did not answer. */
  focus: Schema.optionalKey(Schema.Literals(["secure", "clear", "unknown"])),
});
export type WindowsWindowFacts = typeof WindowsWindowFacts.Type;

const refuse = (reason: ComputerUseRefusalReason, message: string): ComputerUseRefusal => ({
  outcome: "refused",
  reason,
  message,
});

/**
 * A Windows driver read in protocol terms. Cua Driver 0.37.0 reports a toggle control's UIA
 * ToggleState as selected (On true, Off false, Indeterminate left out), and SelectionItem's
 * IsSelected otherwise; on an element that toggles it is the checked state (#1286). What the
 * driver leaves out, an Indeterminate toggle and expand/collapse state, comes from the helper's
 * elementStates, joined by screen rectangle, role and label. A key held by more than one driver
 * element or more than one helper entry joins nothing, and a truncated answer is not used at all:
 * uniqueness cannot be shown from part of the tree.
 */
export function windowsDriverRead(
  read: DriverWindowState,
  states?: WindowsElementStates,
): DriverWindowState {
  if (read.elements === undefined) return read;
  const key = (role: string, label: string | undefined, frame: Frame) =>
    [role, label ?? "", frame.x, frame.y, frame.w, frame.h].join("|");
  const driverKeys = new Map<string, number>();
  for (const element of read.elements)
    if (element.frame) {
      const at = key(element.role, element.label, element.frame);
      driverKeys.set(at, (driverKeys.get(at) ?? 0) + 1);
    }
  const byKey = new Map<string, WindowsElementStates["elements"][number] | null>();
  for (const entry of states && !states.truncated ? states.elements : []) {
    const at = key(entry.role, entry.label, entry.frame);
    byKey.set(at, byKey.has(at) ? null : entry);
  }
  return {
    ...read,
    elements: read.elements.map(({ selected, ...element }) => {
      const at = element.frame ? key(element.role, element.label, element.frame) : undefined;
      const known = at !== undefined && driverKeys.get(at) === 1 ? byKey.get(at) : undefined;
      const checked =
        known?.toggle === "indeterminate"
          ? "mixed"
          : known?.toggle
            ? known.toggle === "on"
            : selected;
      const toggles = element.actions?.includes("toggle") || known?.toggle !== undefined;
      return {
        ...element,
        ...(toggles
          ? checked === undefined
            ? {}
            : { checked }
          : selected === undefined
            ? {}
            : { selected }),
        // PartiallyExpanded counts as open; a leaf cannot expand, so it has no expanded at all.
        ...(known?.expand === undefined || known.expand === "leaf"
          ? {}
          : { expanded: known.expand !== "collapsed" }),
      };
    }),
  };
}

const Frame = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
});
type Frame = typeof Frame.Type;

/** The helper's answer to elementStates: what UI Automation says the driver did not. */
export const WindowsElementStates = Schema.Struct({
  elements: Schema.Array(
    Schema.Struct({
      frame: Frame,
      role: Schema.String,
      label: Schema.optionalKey(Schema.String),
      toggle: Schema.optionalKey(Schema.Literals(["on", "off", "indeterminate"])),
      expand: Schema.optionalKey(Schema.Literals(["collapsed", "expanded", "partial", "leaf"])),
    }),
  ),
  truncated: Schema.Boolean,
});
export type WindowsElementStates = typeof WindowsElementStates.Type;

/**
 * The epoch and private mode for observing or acting on a window, or why the helper refuses to
 * touch it. Private mode fails closed: focus UI Automation could not read counts as secure.
 */
export function windowsObservationTarget(
  facts: WindowsWindowFacts,
): { readonly epoch: string; readonly privateMode: boolean } | ComputerUseRefusal {
  if (!facts.exists) return refuse("windowNotFound", "That window is gone. List windows again.");
  if (facts.ownerMatches !== true)
    return refuse("ownerMismatch", "That window belongs to another process. List windows again.");
  if (facts.sameSession !== true)
    return refuse("targetRefused", "That window is in another Windows session.");
  if (facts.elevatedTarget !== false)
    return refuse(
      "targetRefused",
      "That window runs as administrator, and computer use never reaches elevated windows.",
    );
  if (facts.inputDesktop !== "Default")
    return refuse(
      "screenLocked",
      "The screen is locked or showing a Windows security prompt. Unlock it, then try again.",
    );
  if (!facts.epoch)
    return refuse("helperUnavailable", "GOAT Computer Use could not name that window.");
  return { epoch: facts.epoch, privateMode: facts.focus !== "clear" };
}

/** The helper's answer to permissions on Windows. */
export const WindowsHelperReadiness = Schema.Struct({
  interactiveSession: Schema.Boolean,
  sessionId: Schema.NullOr(Schema.Number),
  consoleSessionId: Schema.Number,
  connectState: Schema.String,
  inputDesktop: Schema.String,
  uiAutomation: Schema.Boolean,
  helperElevated: Schema.Boolean,
});
export type WindowsHelperReadiness = typeof WindowsHelperReadiness.Type;

/**
 * Windows readiness in the shared terms. Windows has no permission to grant, so a grant is
 * granted when the session can do what it stands for and unknown otherwise, with the reason.
 * Capture and the tree count as ready only with proof from a real driver read of a window.
 */
export function windowsComputerUseReadiness(input: {
  readonly facts: WindowsHelperReadiness;
  readonly helper: ComputerUseReadiness["helper"];
  readonly proof?: {
    readonly capture: "ready" | "blank" | "noWindow";
    readonly tree: "ready" | "empty";
  };
}): ComputerUseReadiness {
  const { facts } = input;
  const blockers: Array<ComputerUseReadiness["blockers"][number]> = [];
  const reasons: string[] = [];
  if (!facts.interactiveSession) {
    blockers.push("noInteractiveDesktop");
    reasons.push(
      "GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop. Start GOAT from the signed-in desktop on this computer.",
    );
  } else if (facts.connectState === "disconnected") {
    if (facts.consoleSessionId !== facts.sessionId) blockers.push("otherUserAtConsole");
    reasons.push(
      "This Windows session is disconnected, so there is no screen to see. Reconnect to it, then try again.",
    );
  } else if (facts.inputDesktop !== "Default") {
    blockers.push("screenLocked");
    reasons.push(
      "The screen is locked or showing a Windows security prompt. Unlock it, then try again.",
    );
  }
  if (facts.helperElevated)
    reasons.push(
      "GOAT is running as administrator, and computer use never runs elevated. Start GOAT without Run as administrator.",
    );
  const usable = blockers.length === 0 && facts.interactiveSession && !facts.helperElevated;
  const visible = usable && facts.connectState === "active";
  if (usable && !facts.uiAutomation)
    reasons.push("UI Automation did not answer on this desktop. Try again.");
  if (usable && !visible)
    reasons.push("This Windows session is not showing a screen right now. Sign in to it.");

  const capture = !visible ? "unavailable" : (input.proof?.capture ?? "pending");
  const tree =
    !usable || !facts.uiAutomation ? "unavailable" : (input.proof?.tree ?? "unavailable");
  // One sentence per step that is not ready, in step order.
  const captureReason = {
    ready: undefined,
    pending: "Computer use has not captured a window yet. Run the check.",
    blank: "The screenshot was blank. Keep the window visible.",
    noWindow: "There was no window to capture. Open one, then check again.",
    unavailable: "Screenshots are not possible until this desktop can be used.",
  }[capture];
  if (captureReason) reasons.push(captureReason);
  if (tree === "empty") reasons.push("The window's controls could not be read.");
  if (tree === "unavailable")
    reasons.push(
      usable && facts.uiAutomation
        ? "Computer use has not read a window's controls yet. Run the check."
        : "Window controls cannot be read until this desktop can be used.",
    );
  if (!usable) reasons.push("Agents cannot send input until this desktop can be used.");
  if (input.helper !== "authenticated")
    reasons.push(
      input.helper === "incompatible"
        ? "GOAT Computer Use is a different version than GOAT. Update GOAT."
        : "GOAT Computer Use could not prove it was started by GOAT.",
    );
  return {
    grants: {
      accessibility: usable && facts.uiAutomation ? "granted" : "unknown",
      screenCapture: visible ? "granted" : "unknown",
    },
    helper: input.helper,
    capture,
    tree,
    // UI Automation patterns and posted messages reach a window without raising it.
    input: usable ? "background" : "unavailable",
    blockers,
    reasons,
  };
}
