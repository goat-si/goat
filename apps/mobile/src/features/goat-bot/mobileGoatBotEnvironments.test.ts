import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mobileGoatBotEnvironmentInput } from "./mobileGoatBotEnvironments";

const id = EnvironmentId.make("server-id");
const claim = { environmentId: id, claimedAt: 10, claimId: "claim" };
function entry(): Parameters<typeof mobileGoatBotEnvironmentInput>[0] {
  return {
    environmentId: id,
    label: "Saved computer",
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        label: "Runtime computer",
        capabilities: { repositoryIdentity: false, channelLedger: true, goatBotHome: true },
      },
      settings: { goatBotHome: claim },
    },
  };
}
describe("mobile GOAT Bot environment input", () => {
  it("exposes raw settings and the home readback without a primary machine", () => {
    const source = entry();
    const result = mobileGoatBotEnvironmentInput(source);
    expect(result.label).toBe("Runtime computer");
    expect(result.primary).toBe(false);
    expect(result.settingsSnapshot).toBe(source.serverConfig?.settings);
    expect(result.homeTarget).toEqual({
      environmentId: id,
      connected: true,
      supportsHome: true,
      supportsBot: true,
      settingsLoaded: true,
      home: claim,
    });
  });
  it("falls back from a blank runtime label to the saved label, then id", () => {
    const source = entry();
    const blank = {
      ...source,
      serverConfig: {
        ...source.serverConfig!,
        environment: { ...source.serverConfig!.environment, label: " " },
      },
    };
    expect(mobileGoatBotEnvironmentInput(blank).label).toBe("Saved computer");
    expect(mobileGoatBotEnvironmentInput({ ...blank, label: " " }).label).toBe("server-id");
  });
  it("waits for settings instead of treating a capable unloaded server as unclaimed", () => {
    const source = entry();
    expect(
      mobileGoatBotEnvironmentInput({
        ...source,
        serverConfig: { environment: source.serverConfig!.environment },
      }).homeTarget,
    ).toMatchObject({ settingsLoaded: false, home: null, supportsHome: true });
  });
  it("does not invent capabilities for old or disconnected unknown servers", () => {
    const source = entry();
    expect(
      mobileGoatBotEnvironmentInput({
        ...source,
        connection: { phase: "reconnecting" },
        serverConfig: null,
      }),
    ).toMatchObject({
      connected: false,
      supportsChannelLedger: false,
      homeTarget: {
        connected: false,
        supportsHome: false,
        supportsBot: false,
        settingsLoaded: false,
      },
    });
  });
});
