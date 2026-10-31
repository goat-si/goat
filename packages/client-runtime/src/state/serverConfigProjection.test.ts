import { ServerConfigStreamEvent, type ServerConfig, type ServerProvider } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });
});

describe("applyServerConfigProjection provider updates from a newer server", () => {
  const wireProvider = (instanceId: string, status: string) => ({
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  });
  const decodeEvent = Schema.decodeUnknownSync(ServerConfigStreamEvent);
  const applied = (wire: unknown) => {
    const providers = ["codex", "claude"].map((id) => decodeProvider(wireProvider(id, "ready")));
    const current = Option.some({
      config: { providers } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, decodeEvent(wire));
    return Option.getOrThrow(next).config.providers.map((provider) => provider.instanceId);
  };
  const decodeProvider = (wire: unknown) =>
    (
      decodeEvent({ version: 1, type: "providerStatuses", payload: { providers: [wire] } }) as {
        readonly payload: { readonly providers: ReadonlyArray<ServerProvider> };
      }
    ).payload.providers[0]!;

  it("a changes event drops a provider this client cannot read, as a full list does", () => {
    const unreadable = wireProvider("codex", "a-status-from-a-newer-server");
    const fromFullList = applied({
      version: 1,
      type: "providerStatuses",
      payload: { providers: [unreadable, wireProvider("claude", "ready")] },
    });
    const fromChanges = applied({
      version: 1,
      type: "providerStatusChanges",
      payload: {
        instanceIds: ["codex", "claude"],
        changedInstanceIds: ["codex"],
        providers: [unreadable],
      },
    });

    expect(fromFullList).toEqual(["claude"]);
    expect(fromChanges).toEqual(fromFullList);
  });
});
