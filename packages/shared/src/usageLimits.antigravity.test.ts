import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitAccounts } from "./usageLimits.ts";

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

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

describe("pools", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("merges a local Antigravity login with its hub account by Google account fingerprint", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const local = provider({
      driver: antigravity,
      instanceId: ProviderInstanceId.make("antigravity"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "google-key",
        windows: [{ ...window, id: "gemini-weekly", usedPercent: 20 }],
      },
    });
    const hubAccount = {
      id: "antigravity-g@example.com.json",
      driver: antigravity,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        credentialFingerprint: "google-key",
        windows: [{ ...window, id: "gemini-weekly", usedPercent: 30 }],
      },
    };
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [local],
              usageLimitSources: [{ ...source, accounts: [hubAccount] }],
            },
          },
        ],
      ]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(30);
  });
});
