// Seam for v1 apps/web/src/connection/desktopLocal.ts (goat 916b5ccc1b2): GOAT 2's one environment is its own local
// host, never a v1 desktop-local backend or WSL distro.
import type { ConnectionTarget } from "@goat/client-runtime/connection";

export function isDesktopLocalConnectionTarget(_target: ConnectionTarget): boolean {
  return false;
}

export function isWslConnectionTarget(_target: ConnectionTarget): boolean {
  return false;
}
