// v1 apps/web/src/vite-env.d.ts (goat 916b5ccc1b2) global declarations the lifted files compile against. GOAT 2's shell
// never sets window.desktopBridge (the lifted env.ts then reports isElectron = false), so these paths stay inert.
// Lane F adds GOAT_FEATURE_SECRETS (env.ts) and the mdast math node types v1 gets from mdast-util-math
// (TimelineWorkEntryRow.logic). mdast-util-math is installed at v1's version with v1's patch.
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
