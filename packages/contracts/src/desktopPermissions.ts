import * as Schema from "effect/Schema";

export const SystemSettingsPaneSchema = Schema.Literals([
  "full-disk-access",
  "accessibility",
  "screen-recording",
  "microphone",
]);
export type SystemSettingsPane = typeof SystemSettingsPaneSchema.Type;

/** `unsupported`: the OS has no app-level microphone grant to ask for; the browser decides. */
export const DesktopMicrophoneAccessSchema = Schema.Literals([
  "granted",
  "denied",
  "restricted",
  "unavailable",
  "unsupported",
]);
export type DesktopMicrophoneAccess = typeof DesktopMicrophoneAccessSchema.Type;

export interface DesktopMicrophoneBridge {
  /** Asks macOS for the microphone when it has not asked yet. Older builds lack this. */
  requestMicrophoneAccess?: () => Promise<DesktopMicrophoneAccess>;
}
