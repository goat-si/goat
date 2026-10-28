import type { DesktopMicrophoneAccess } from "@goat/contracts";

export interface MediaPermissionWebContents {
  readonly isDestroyed: () => boolean;
  readonly getType: () => string;
}

interface MediaPermissionRequestDetails {
  readonly isMainFrame?: boolean;
  readonly requestingUrl?: string;
  readonly mediaTypes?: ReadonlyArray<string>;
}

interface MediaPermissionCheckDetails {
  readonly isMainFrame?: boolean;
  readonly mediaType?: string;
}

export interface MediaPermissionPolicyOptions<W extends MediaPermissionWebContents> {
  readonly appScheme: string;
  readonly appHost: string;
  readonly platform: NodeJS.Platform;
  readonly isCurrentMainWebContents: (webContents: W) => boolean;
  /** `systemPreferences.getMediaAccessStatus("microphone")`. */
  readonly readMicrophoneStatus: () => string;
  readonly askForMicrophone: () => Promise<boolean>;
}

/**
 * The main window's session grants the microphone only to GOAT's own renderer, in its top
 * frame, for audio alone. Preview partitions keep their own handlers. Other permissions keep
 * Electron's defaults, which notifications, clipboard and fullscreen rely on.
 */
export function createMediaPermissionPolicy<W extends MediaPermissionWebContents>(
  options: MediaPermissionPolicyOptions<W>,
) {
  let pendingAsk: Promise<DesktopMicrophoneAccess> | null = null;

  const isAppOrigin = (url: string | undefined) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === `${options.appScheme}:` && parsed.host === options.appHost;
    } catch {
      return false;
    }
  };

  const isAppWindow = (webContents: W | null): webContents is W => {
    if (!webContents) return false;
    try {
      return (
        !webContents.isDestroyed() &&
        webContents.getType() === "window" &&
        options.isCurrentMainWebContents(webContents)
      );
    } catch {
      return false;
    }
  };

  const allowsAudioRequest = (webContents: W, details: MediaPermissionRequestDetails) =>
    details.isMainFrame === true &&
    isAppOrigin(details.requestingUrl) &&
    details.mediaTypes !== undefined &&
    details.mediaTypes.length > 0 &&
    details.mediaTypes.every((type) => type === "audio") &&
    isAppWindow(webContents);

  const requestMicrophoneAccess = (): Promise<DesktopMicrophoneAccess> => {
    if (options.platform !== "darwin") return Promise.resolve("unsupported");
    let status: string;
    try {
      status = options.readMicrophoneStatus();
    } catch {
      return Promise.resolve("unavailable");
    }
    if (status === "granted" || status === "denied" || status === "restricted")
      return Promise.resolve(status);
    if (status !== "not-determined") return Promise.resolve("unavailable");
    pendingAsk ??= options
      .askForMicrophone()
      .then(
        (granted): DesktopMicrophoneAccess => (granted ? "granted" : "denied"),
        (): DesktopMicrophoneAccess => "unavailable",
      )
      .finally(() => {
        pendingAsk = null;
      });
    return pendingAsk;
  };

  return {
    requestMicrophoneAccess,
    request: (
      webContents: W,
      permission: string,
      callback: (granted: boolean) => void,
      details: MediaPermissionRequestDetails,
    ) => {
      if (permission !== "media") return callback(electronDefault(permission));
      if (!allowsAudioRequest(webContents, details)) return callback(false);
      void requestMicrophoneAccess().then((access) =>
        callback(
          (access === "granted" || access === "unsupported") &&
            allowsAudioRequest(webContents, details),
        ),
      );
    },
    check: (
      webContents: W | null,
      permission: string,
      requestingOrigin: string,
      details: MediaPermissionCheckDetails,
    ) =>
      permission !== "media"
        ? electronDefault(permission)
        : details.mediaType === "audio" &&
          details.isMainFrame === true &&
          isAppOrigin(requestingOrigin) &&
          isAppWindow(webContents),
  };
}

// Electron's permission manager allows everything without a handler except this one.
const electronDefault = (permission: string) => permission !== "deprecated-sync-clipboard-read";
