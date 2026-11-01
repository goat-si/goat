import * as Schema from "effect/Schema";

export const PREVIEW_SESSION_STACK_WINDOW_NAME = "goat-preview-session-stack";

/** Electron's OS API, not a promise that every capture application honours it. */
export const DesktopStackCaptureProtection = Schema.Literals([
  "macos-sharing-none",
  "windows-exclude-from-capture",
  "windows-monitor-only",
  "unsupported",
]);

export const DesktopPreviewSessionStackState = Schema.Struct({
  poppedOut: Schema.Boolean,
  open: Schema.Boolean,
  visible: Schema.Boolean,
  maxHeight: Schema.Number,
  captureProtection: DesktopStackCaptureProtection,
  mouseEventForwarding: Schema.Boolean,
});
export type DesktopPreviewSessionStackState = typeof DesktopPreviewSessionStackState.Type;

const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export const DesktopPreviewSessionStackRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state") }),
  Schema.Struct({ type: Schema.Literal("dock") }),
  Schema.Struct({ type: Schema.Literal("release") }),
  Schema.Struct({
    type: Schema.Literal("layout"),
    height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ type: Schema.Literal("interactive"), interactive: Schema.Boolean }),
  // Coordinates in the owner's content area, in CSS pixels; never remote screen coordinates.
  Schema.Struct({
    type: Schema.Literal("pointer"),
    tabId: Schema.String,
    point: Schema.NullOr(Point),
  }),
]);
export type DesktopPreviewSessionStackRequest = typeof DesktopPreviewSessionStackRequest.Type;

export interface DesktopPreviewSessionStackBridge {
  request: (input: DesktopPreviewSessionStackRequest) => Promise<DesktopPreviewSessionStackState>;
  onState: (listener: (state: DesktopPreviewSessionStackState) => void) => () => void;
}

/** The desktop bridge's part for the stack; absent outside the desktop app. */
export interface DesktopPreviewSessionStackHost {
  readonly previewSessionStack?: DesktopPreviewSessionStackBridge;
}
