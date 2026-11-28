// Driver kinds GOAT 2 targets, matching goat origin/dev ProviderDriverKind values.
// TODO: port provider adapters (packages/provider-*) one by one; each adapter must
//  1) probe `cliVersion` at run start and write a RuntimeStamp,
//  2) expose its native session log location so transcripts are read, not copied.
export const TARGET_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "grok",
  "muse",
  "acpRegistry",
  "cursorCloud",
  "devinCloud",
] as const;

export type TargetDriver = (typeof TARGET_DRIVERS)[number];

export function listDrivers(): ReadonlyArray<TargetDriver> {
  return TARGET_DRIVERS;
}
