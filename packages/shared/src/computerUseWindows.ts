import {
  type ComputerUseReadiness,
  type ComputerUseRefusal,
  type ComputerUseRefusalReason,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

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
