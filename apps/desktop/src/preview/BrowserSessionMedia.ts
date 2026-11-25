import { systemPreferences } from "electron";

export type MediaDevice = "camera" | "microphone";

export const mediaDeviceFor = (mediaType: string | undefined): MediaDevice | null =>
  mediaType === "video" ? "camera" : mediaType === "audio" ? "microphone" : null;

export const mediaRequestMessage = (devices: ReadonlyArray<MediaDevice>, origin: string): string =>
  devices.length === 2
    ? `${origin} wants to use your camera and microphone`
    : devices[0] === "microphone"
      ? `${origin} wants to use your microphone`
      : `${origin} wants to use your camera`;

export const mediaBlockedMessage = (devices: ReadonlyArray<MediaDevice>): string =>
  devices.length === 2
    ? "macOS blocked GOAT from using your camera and microphone"
    : devices[0] === "microphone"
      ? "macOS blocked GOAT from using your microphone"
      : "macOS blocked GOAT from using your camera";

export const MEDIA_BLOCKED_DETAIL =
  "Allow GOAT in System Settings › Privacy & Security, then restart GOAT.";

/**
 * macOS gates capture devices per app and lists an app under Privacy & Security
 * only after it asks, so ask the OS once the user allowed the page.
 * Returns the devices macOS blocks, so the recovery message names only those; empty means allowed.
 */
export const ensureSystemMediaAccess = async (
  platform: NodeJS.Platform,
  devices: ReadonlyArray<MediaDevice>,
): Promise<ReadonlyArray<MediaDevice>> => {
  if (platform !== "darwin") return [];
  const statuses = devices.map((device) => systemPreferences.getMediaAccessStatus(device));
  const refused = devices.filter(
    (_device, index) => statuses[index] !== "granted" && statuses[index] !== "not-determined",
  );
  if (refused.length > 0) return refused;
  const results = await Promise.all(
    devices.map((device, index) =>
      statuses[index] === "granted"
        ? true
        : systemPreferences.askForMediaAccess(device).catch(() => false),
    ),
  );
  return devices.filter((_device, index) => !results[index]);
};

/** The camera and microphone answers given in one preview Session. */
export interface MediaConsent {
  readonly decisions: Map<string, boolean>;
  /** Bumped by each reset, so an answer to an older prompt cannot restore a decision. */
  resets: number;
}
