import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
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

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

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
  it("shows the reason an account's limits are unsupported, but not a bare unsupported", () => {
    const unsupported = (message?: string) =>
      provider({
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported", ...(message ? { message } : {}) },
        },
      });
    const notices = (limited: ServerProvider) =>
      collectLimitNotices(
        new Map([
          [
            EnvironmentId.make("a"),
            { entry: { target: { label: "Host" } }, serverConfig: { providers: [limited] } },
          ],
        ]),
      );
    expect(notices(unsupported("Sign in with Google to see Antigravity limits."))).toEqual([
      "codex: Sign in with Google to see Antigravity limits.",
    ]);
    expect(notices(unsupported())).toEqual([]);
  });
  it("names a hub account whose read failed unless another environment read it", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    const account = {
      id: "claude-tg@example.com.json",
      driver: ProviderDriverKind.make("claudeAgent"),
      email: "tg@example.com",
    };
    const failed = {
      ...account,
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed" as const,
          message: "The provider refused the hub request (HTTP 429).",
        },
      },
    };
    const read = {
      ...account,
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 10 }] },
    };
    const hub = (accounts: readonly UsageLimitSourceAccount[]) => ({
      providers: [],
      usageLimitSources: [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy" as const,
          label: "hub",
          checkedAt,
          accounts,
        },
      ],
    });
    const desktop = { entry: { target: { label: "Desktop" } }, serverConfig: hub([failed]) };
    expect(collectLimitNotices(new Map([[EnvironmentId.make("a"), desktop]]))).toEqual([
      "hub · tg@example.com: The provider refused the hub request (HTTP 429).",
    ]);
    expect(
      collectLimitNotices(
        new Map([
          [EnvironmentId.make("a"), desktop],
          [
            EnvironmentId.make("b"),
            { entry: { target: { label: "WSL" } }, serverConfig: hub([read]) },
          ],
        ]),
      ),
    ).toEqual([]);
    // The row resolves an omitted workspace to the only one known, so the notice must too.
    expect(
      collectLimitNotices(
        new Map([
          [EnvironmentId.make("a"), desktop],
          [
            EnvironmentId.make("b"),
            {
              entry: { target: { label: "WSL" } },
              serverConfig: hub([{ ...read, workspaceId: "ws-1" }]),
            },
          ],
        ]),
      ),
    ).toEqual([]);
    // Without an email, same-named auth files on two environment-local hubs are different accounts.
    const { email: _failedEmail, ...anonymousFailed } = failed;
    const { email: _readEmail, ...anonymousRead } = read;
    expect(
      collectLimitNotices(
        new Map([
          [EnvironmentId.make("a"), { ...desktop, serverConfig: hub([anonymousFailed]) }],
          [
            EnvironmentId.make("b"),
            { entry: { target: { label: "WSL" } }, serverConfig: hub([anonymousRead]) },
          ],
        ]),
      ),
    ).toEqual([
      "Desktop · hub · claude-tg@example.com: The provider refused the hub request (HTTP 429).",
    ]);
  });
});
