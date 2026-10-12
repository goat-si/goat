import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSendToGoatBot,
  environmentSupportsChannelLedger,
  resolveGoatBotRemoval,
  pickGoatBotEnvironment,
  resolveGoatBotAvailability,
  type GoatBotEnvironmentInput,
} from "./goatBotAvailability";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const botThread = ThreadId.make("bot");

const env = (
  environmentId: EnvironmentId,
  overrides: Partial<GoatBotEnvironmentInput> = {},
): GoatBotEnvironmentInput => ({
  environmentId,
  connected: true,
  supportsChannelLedger: true,
  primary: environmentId === primary,
  ...overrides,
});

describe("pickGoatBotEnvironment", () => {
  it("prefers the known bot's machine, then a supporting primary, then any supporter", () => {
    const both = [env(remote), env(primary)];
    expect(
      pickGoatBotEnvironment(both, { environmentId: remote, threadId: botThread })?.environmentId,
    ).toBe(remote);
    expect(pickGoatBotEnvironment(both, null)?.environmentId).toBe(primary);
    expect(
      pickGoatBotEnvironment([env(primary, { supportsChannelLedger: false }), env(remote)], null)
        ?.environmentId,
    ).toBe(remote);
    expect(
      pickGoatBotEnvironment([env(primary, { supportsChannelLedger: false })], null),
    ).toBeNull();
  });
});

describe("resolveGoatBotAvailability", () => {
  const confirmed = {
    state: "confirmed",
    bot: { environmentId: primary, threadId: botThread },
  } as const;

  it("is unsupported when no machine offers GOAT Bot", () => {
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary, { supportsChannelLedger: false })],
        botRef: null,
        ensure: { state: "idle" },
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("stops being ready when the known bot's machine loses support", () => {
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary, { supportsChannelLedger: false })],
        botRef: confirmed.bot,
        ensure: confirmed,
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("reports an offline machine", () => {
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary, { connected: false })],
        botRef: confirmed.bot,
        ensure: confirmed,
      }),
    ).toEqual({ kind: "offline", environmentId: primary });
  });

  it("waits for the server to confirm a remembered bot on this connection", () => {
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary)],
        botRef: confirmed.bot,
        ensure: { state: "idle" },
      }),
    ).toEqual({ kind: "connecting", environmentId: primary });
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary)],
        botRef: confirmed.bot,
        ensure: confirmed,
      }),
    ).toEqual({ kind: "ready", bot: confirmed.bot });
  });

  it("surfaces a busy global agent and failures", () => {
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary)],
        botRef: null,
        ensure: { state: "legacy_active" },
      }),
    ).toEqual({ kind: "legacy_active", environmentId: primary });
    expect(
      resolveGoatBotAvailability({
        environments: [env(primary)],
        botRef: null,
        ensure: { state: "failed", message: "Nope" },
      }),
    ).toEqual({ kind: "error", environmentId: primary, message: "Nope" });
  });

  it("allows sending only when ready and permitted", () => {
    const ready = resolveGoatBotAvailability({
      environments: [env(primary)],
      botRef: confirmed.bot,
      ensure: confirmed,
    });
    expect(canSendToGoatBot(ready, true)).toBe(true);
    expect(canSendToGoatBot(ready, false)).toBe(false);
    expect(canSendToGoatBot({ kind: "connecting", environmentId: primary }, true)).toBe(false);
  });
});

describe("environmentSupportsChannelLedger", () => {
  it("treats a server that does not advertise channels as unsupported", () => {
    expect(environmentSupportsChannelLedger(undefined)).toBe(false);
    expect(environmentSupportsChannelLedger({ repositoryIdentity: true })).toBe(false);
    expect(
      environmentSupportsChannelLedger({ repositoryIdentity: true, channelLedger: false }),
    ).toBe(false);
    expect(
      environmentSupportsChannelLedger({ repositoryIdentity: true, channelLedger: true }),
    ).toBe(true);
  });
});

describe("resolveGoatBotRemoval", () => {
  const missing = {
    shell: null,
    shellSeen: true,
    archived: false,
    bootstrapped: true,
    confirmedHere: true,
  };
  it("distinguishes archive membership from a seen shell removed from the active store", () => {
    expect(resolveGoatBotRemoval({ ...missing, shell: {} })).toBe(null);
    expect(resolveGoatBotRemoval({ ...missing, archived: true })).toBe("archived");
    expect(resolveGoatBotRemoval({ ...missing, archived: true, shellSeen: false })).toBe(
      "archived",
    );
    expect(resolveGoatBotRemoval(missing)).toBe("deleted");
  });

  it("waits for bootstrap, confirmation and the archived snapshot before resolving removal", () => {
    expect(resolveGoatBotRemoval({ ...missing, bootstrapped: false })).toBe(null);
    expect(resolveGoatBotRemoval({ ...missing, confirmedHere: false })).toBe(null);
    expect(resolveGoatBotRemoval({ ...missing, archived: null })).toBe(null);
  });

  it("never calls a shell deleted before it has appeared in this mount", () => {
    expect(resolveGoatBotRemoval({ ...missing, shellSeen: false })).toBe(null);
  });
});
