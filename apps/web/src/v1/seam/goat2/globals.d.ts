// v1 apps/web/src/vite-env.d.ts (goat 916b5ccc1b2) global declarations the lifted files compile against. GOAT 2's shell
// never sets window.desktopBridge (the lifted env.ts then reports isElectron = false), so these paths stay inert.
import type { DesktopBridge } from "@goat/contracts";

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export {};
