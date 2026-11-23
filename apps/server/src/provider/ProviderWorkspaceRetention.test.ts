import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { mergeProviderSnapshot, upsertProviderWorkspaceSnapshot } from "./ProviderRegistry.ts";

const signedIn = {
  instanceId: ProviderInstanceId.make("antigravity-personal"),
  driver: ProviderDriverKind.make("antigravity"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
  checkedAt: "2026-09-05T00:00:00.000Z",
  version: "agy_acp_server_1.1.1",
  models: [
    {
      slug: "gemini-3.7-flash-high",
      name: "Gemini 3.7 Flash",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [{ name: "plan" }],
  skills: [],
} as const satisfies ServerProvider;
const restartProbe = {
  ...signedIn,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-09-05T00:01:00.000Z",
  models: [],
} as const satisfies ServerProvider;

it("keeps scanned folders through health checks until Antigravity cannot run", () => {
  const scanned = ["/project", "/plain"].reduce<ServerProvider>(
    (provider, cwd) =>
      upsertProviderWorkspaceSnapshot(provider, cwd, {
        ...signedIn,
        skills: [{ name: "review", path: `${cwd}/SKILL.md`, enabled: true }],
      }),
    signedIn,
  );
  const healthCheck = { ...signedIn, checkedAt: "2026-09-05T00:01:00.000Z" };
  const sessionFolder = {
    cwd: "/project",
    checkedAt: healthCheck.checkedAt,
    slashCommands: [{ name: "swarm" }],
    skills: [],
  };
  const kept = [
    healthCheck,
    restartProbe,
    { ...restartProbe, installed: false, version: null },
  ] satisfies ReadonlyArray<ServerProvider>;
  for (const next of kept) {
    assert.deepStrictEqual(
      mergeProviderSnapshot(scanned, { ...next, workspaceSnapshots: [] }).workspaceSnapshots,
      scanned.workspaceSnapshots,
    );
  }
  assert.deepStrictEqual(
    mergeProviderSnapshot(scanned, {
      ...healthCheck,
      workspaceSnapshots: [sessionFolder],
    }).workspaceSnapshots,
    [...scanned.workspaceSnapshots!.slice(1), sessionFolder],
  );
  const cleared = [
    { ...healthCheck, auth: { status: "unauthenticated" } },
    { ...healthCheck, status: "disabled", enabled: false },
    { ...healthCheck, status: "error", installed: false },
  ] satisfies ReadonlyArray<ServerProvider>;
  for (const next of cleared) {
    assert.deepStrictEqual(
      mergeProviderSnapshot(scanned, { ...next, workspaceSnapshots: [] }).workspaceSnapshots,
      [],
    );
  }
});
