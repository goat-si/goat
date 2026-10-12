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
  const live = { archivedAt: null, deletedAt: null };
  it("keeps an archived bot as the bot and marks a deleted one for replacement", () => {
    expect(resolveGoatBotRemoval({ shell: live, bootstrapped: true, confirmedHere: true })).toBe(
      null,
    );
    expect(
      resolveGoatBotRemoval({
        shell: { archivedAt: "2026-10-12T00:00:00.000Z", deletedAt: null },
        bootstrapped: true,
        confirmedHere: true,
      }),
    ).toBe("archived");
    expect(
      resolveGoatBotRemoval({
        shell: { archivedAt: null, deletedAt: "2026-10-12T00:00:00.000Z" },
        bootstrapped: true,
        confirmedHere: true,
      }),
    ).toBe("deleted");
  });

  it("waits for the machine's threads and the just-confirmed bot before calling it deleted", () => {
    expect(resolveGoatBotRemoval({ shell: null, bootstrapped: false, confirmedHere: false })).toBe(
      null,
    );
    expect(resolveGoatBotRemoval({ shell: null, bootstrapped: true, confirmedHere: true })).toBe(
      null,
    );
    expect(resolveGoatBotRemoval({ shell: null, bootstrapped: true, confirmedHere: false })).toBe(
      "deleted",
    );
  });
});
