import type { DesktopPreviewSessionStackHost } from "./desktopPreviewSessionStack.ts";
import type { DesktopWindowMaterialBridge } from "./desktopWindowMaterial.ts";

/** Whether the loopback headless server (SSH work on ~/.goat) shows as an environment. */
export interface DesktopHeadlessServerBridge {
  getHeadlessServerAttachEnabled?: () => boolean;
  setHeadlessServerAttachEnabled?: (enabled: boolean) => Promise<void>;
}

/** Desktop bridge methods that live in their own modules, so ipc.ts stays within its budget. */
export type DesktopBridgeParts = DesktopWindowMaterialBridge &
  DesktopPreviewSessionStackHost &
  DesktopHeadlessServerBridge;
