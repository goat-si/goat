import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
export function makeWorkspaceProviderFixture() {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const snapshotFor = (cwd: string, checkedAt: string) => ({
    cwd,
    checkedAt,
    slashCommands: [{ name: `${cwd.slice(1)}-command` }],
    skills: [],
  });
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-25T00:00:00.000Z",
    models: [],
    slashCommands: [{ name: "machine-command" }],
    skills: [],
    workspaceSnapshots: [
      snapshotFor("/a", "2026-10-25T00:00:00.000Z"),
      snapshotFor("/b", "2026-10-25T00:00:00.000Z"),
    ],
  };
  return { instanceId, snapshotFor, provider };
}
