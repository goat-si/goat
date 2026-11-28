// Seam (lane F): replaces v1 apps/web/src/state/entities.ts @916b5cc. v1 reads thread shells from its environment atoms. The timeline uses useThreadShell only to title and link a
// "read thread" row; GOAT 2 has no v1 shell for other threads yet, so the row shows its unlinked label (v1's own
// fallback when the shell is missing). Planned: map GOAT 2 thread cards here.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { ScopedThreadRef } from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";

export function useThreadShell(_ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return null;
}
