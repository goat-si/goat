import * as Schema from "effect/Schema";

export const DesktopStopReason = Schema.Literals([
  "quit",
  "relaunch",
  "update-install",
  "recovery-retry",
  "recovery-stop",
  "instance-closed",
]);
export type DesktopStopReason = typeof DesktopStopReason.Type;

export const DesktopStopIntent = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  reason: DesktopStopReason,
  requestedAt: Schema.String,
});
export type DesktopStopIntent = typeof DesktopStopIntent.Type;

export const DESKTOP_STOP_INTENT_FILE = "desktop-stop-intent.json";
