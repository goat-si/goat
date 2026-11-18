import { DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER } from "@goat/contracts";

export const requestRecordingCaptureExpression = (tabId: string): string =>
  `globalThis[${JSON.stringify(DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER)}]?.(${JSON.stringify(tabId)}) === true`;

export const recordingFileExtension = (mimeType: string): string => {
  const subtype = mimeType.split(";", 1)[0]?.trim().toLowerCase().split("/")[1] ?? "";
  const extension = subtype.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return extension || "video";
};
