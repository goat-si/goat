import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitNotices } from "./usageLimits.ts";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("external usage settings", () => {
  it("shows a notice once when environments with one label report the same failure", () => {
    const failing = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    });
    const host = { entry: { target: { label: "Host" } }, serverConfig: { providers: [failing] } };
    const presentations = new Map([
      [EnvironmentId.make("a"), host],
      [EnvironmentId.make("b"), host],
      [EnvironmentId.make("c"), host],
    ]);
    expect(collectLimitNotices(presentations)).toEqual(["Host · codex: Could not read limits."]);
  });
});
