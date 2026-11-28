// Seam (lane F): v1 apps/web/src/vite-env.d.ts @916b5cc, the parts lifted v1 files read: window.desktopBridge (absent
// in GOAT 2, so isElectron is false and no host locale is read), GOAT_FEATURE_SECRETS, and the mdast math node types
// v1 gets from mdast-util-math. Listed in docs/PROVENANCE.md (v1 bridge table).
/// <reference types="mdast-util-math" />
import type { DesktopBridge } from "@goat/contracts";

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
  interface ImportMetaEnv {
    readonly GOAT_FEATURE_SECRETS?: string;
  }
}

export {};
