import { Schema } from "effect";

export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
] as const;

export const PREVIEW_AUTOMATION_SERVER_OPERATIONS = [
  ...PREVIEW_AUTOMATION_OPERATIONS,
  "claim",
  "dialog",
  "close",
  "upload",
  "hover",
  "select",
  "drag",
  "back",
  "forward",
  "reload",
  "logs",
  "fetch",
  "scrollCollect",
  "fillSecret",
  "read",
  "signInState",
] as const;
export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_SERVER_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;
