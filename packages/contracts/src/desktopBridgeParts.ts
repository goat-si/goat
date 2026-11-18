import type { DesktopMicrophoneBridge } from "./desktopPermissions.ts";
import type { DesktopPreviewSessionStackHost } from "./desktopPreviewSessionStack.ts";
import type { DesktopTrayBridge } from "./desktopTray.ts";
import type { DesktopWindowMaterialBridge } from "./desktopWindowMaterial.ts";

/** Whether the loopback headless server (SSH work on ~/.goat) shows as an environment. */
export interface DesktopHeadlessServerBridge {
  getHeadlessServerAttachEnabled?: () => boolean;
  setHeadlessServerAttachEnabled?: (enabled: boolean) => Promise<void>;
}

export interface DesktopPrimaryPasteBridge {
  /** False when the OS turned off middle-click PRIMARY paste (`gtk-enable-primary-paste`). */
  getPrimaryPasteEnabled?: () => boolean;
}

/** Desktop bridge methods that live in their own modules, so ipc.ts stays within its budget. */
export type DesktopBridgeParts = DesktopPrimaryPasteBridge &
  DesktopWindowMaterialBridge &
  DesktopPreviewSessionStackHost &
  DesktopHeadlessServerBridge &
  DesktopTrayBridge &
  DesktopMicrophoneBridge;
