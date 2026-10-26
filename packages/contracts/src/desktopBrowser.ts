import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ComputerUseCursorState } from "./computerUseOverlay.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
    cursor: Schema.optionalKey(ComputerUseCursorState),
  }),
  /** Whether an agent turn runs on the thread, so the tabs it uses stay focused between steps. */
  Schema.Struct({
    type: Schema.Literal("turn"),
    threadId: TrimmedNonEmptyString,
    active: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("cursor-state"), ...TabKey, cursor: ComputerUseCursorState }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

/** An agent's pointer on a desktop tab, as the browser host relays it to the app window. */
export interface DesktopPreviewPointerEvent {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  sequence: number;
  createdAt: string;
  cursor?: typeof ComputerUseCursorState.Type;
}

export interface DesktopPreviewCursorStateEvent {
  readonly type: "cursor-state";
  readonly tabId: string;
  readonly cursor: typeof ComputerUseCursorState.Type;
  readonly sequence: number;
  readonly createdAt: string;
}

export type DesktopPreviewCursorEvent =
  | DesktopPreviewPointerEvent
  | DesktopPreviewCursorStateEvent;

/**
 * A screenshot of a server tab starting or settling. Chromium answers one with the guest's next
 * frame, and a guest parked outside the window composites none, so the app keeps it painting.
 */
export interface DesktopPreviewCaptureEvent {
  threadId: string;
  tabId: string;
  capturing: boolean;
}
