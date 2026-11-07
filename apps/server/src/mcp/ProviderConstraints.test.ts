import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { providerConstraints, providerForCaller } from "./ProviderConstraints.ts";

it("reports a provider disabled for the caller's project while retaining global availability", () => {
  const instanceId = ProviderInstanceId.make("custom-codex");
  const projectId = ProjectId.make("project-off");
  const otherProjectId = ProjectId.make("project-on");
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
    },
    projectSettingsOverrides: {
      [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
    },
  };
  expect(providerConstraints(providerForCaller(provider, settings, projectId), true)).toEqual([
    "Provider instance is disabled.",
  ]);
  expect(providerConstraints(providerForCaller(provider, settings, otherProjectId), true)).toEqual(
    [],
  );
  expect(providerConstraints(providerForCaller(provider, settings, undefined), true)).toEqual([]);
});
