// Seam for v1 apps/web/src/components/settings/CodexSetupSection.tsx (goat 916b5ccc1b2): v1 shows these only for
// managed Codex accounts (OpenCodex Home, setupMode "managed"); GOAT 2 Codex uses the signed-in codex CLI
// (setupMode "existing"), so they render nothing. Props are v1's (CodexSetupSection.types.ts).
import type { CodexSetupSectionProps } from "../../../components/settings/CodexSetupSection.types";

export function CodexSetupSection(_props: CodexSetupSectionProps): null {
  return null;
}

export function CodexManagedRuntimeFields(_props: { readonly [prop: string]: unknown }): null {
  return null;
}

export function AddManagedCodexAccountDialog(_props: { readonly [prop: string]: unknown }): null {
  return null;
}
