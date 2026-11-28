// Seam for v1 apps/web/src/environments/primary/target.ts (goat 916b5ccc1b2): GOAT 2 (Dev) always talks to the host
// its desktop shell started, which v1 calls a desktop-managed primary target.
export interface PrimaryEnvironmentTarget {
  readonly source: "desktop-managed";
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  return { source: "desktop-managed" };
}
