import type { DesktopPreviewSessionStackHost } from "./desktopPreviewSessionStack.ts";
import type { DesktopWindowMaterialBridge } from "./desktopWindowMaterial.ts";

/** Desktop bridge methods that live in their own modules, so ipc.ts stays within its budget. */
export type DesktopBridgeParts = DesktopWindowMaterialBridge & DesktopPreviewSessionStackHost;
