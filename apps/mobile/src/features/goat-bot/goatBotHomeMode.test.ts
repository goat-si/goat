import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  effectiveHomeMode,
  mobileGoatBotKnown,
  mobileGoatBotDetailOpen,
  mobileGoatBotWorkspaceVisible,
  pickMobileGoatBotEnvironment,
} from "./goatBotHomeMode";

const botRef = {
  environmentId: EnvironmentId.make("cached"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("bot"),
};
function environment(
  id: string,
  patch: Partial<GoatBotEnvironmentInput> = {},
): GoatBotEnvironmentInput {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connected: true,
    supportsChannelLedger: true,
    primary: false,
    ...patch,
  };
}

describe("mobile GOAT Bot home mode", () => {
  it("defaults to threads and ignores a bot preference until a bot is known", () => {
    expect(effectiveHomeMode(undefined, true)).toBe("thread");
    expect(effectiveHomeMode("thread", true)).toBe("thread");
    expect(effectiveHomeMode("bot", false)).toBe("thread");
  });
  it("keeps bot mode when its known environment disconnects", () => {
    const environments = [environment("cached", { connected: false })];
    expect(effectiveHomeMode("bot", mobileGoatBotKnown(environments, botRef))).toBe("bot");
  });
  it("knows a stored bot even if its environment is missing", () => {
    expect(mobileGoatBotKnown([], botRef)).toBe(true);
    expect(mobileGoatBotKnown([], null)).toBe(false);
  });
  it("knows advertised support independently of the connection phase", () => {
    expect(mobileGoatBotKnown([environment("offline", { connected: false })], null)).toBe(true);
    expect(mobileGoatBotKnown([environment("old", { supportsChannelLedger: false })], null)).toBe(
      false,
    );
  });
  it("keeps the switch visible for a claim whose machine is absent", () => {
    expect(
      mobileGoatBotKnown([], null, {
        environmentId: EnvironmentId.make("gone"),
        claimedAt: 1,
        claimId: "claim",
      }),
    ).toBe(true);
  });
  it("picks connected supported environments by label with a deterministic tie break", () => {
    const a = environment("a", { label: "Same" });
    const b = environment("b", { label: "Same" });
    expect(pickMobileGoatBotEnvironment([b, a], null)).toBe(a);
    expect(pickMobileGoatBotEnvironment([a, b], null)).toBe(a);
    expect(
      pickMobileGoatBotEnvironment([b, environment("c", { label: "Earlier" })], null)
        ?.environmentId,
    ).toBe("c");
  });
  it("never migrates an offline or reconnecting cached bot to another environment", () => {
    for (const connecting of [false, true]) {
      const cached = { ...environment("cached", { connected: false }), connecting };
      expect(pickMobileGoatBotEnvironment([environment("other"), cached], botRef)).toBe(cached);
    }
  });
  it("never substitutes another server when the saved environment is missing or unsupported", () => {
    expect(pickMobileGoatBotEnvironment([environment("other")], botRef)).toBeNull();
    const cached = environment("cached", { supportsChannelLedger: false });
    expect(pickMobileGoatBotEnvironment([environment("other"), cached], botRef)).toBe(cached);
  });
  it("does not select disconnected or unsupported servers without a cached bot", () => {
    expect(
      pickMobileGoatBotEnvironment(
        [
          environment("offline", { connected: false }),
          environment("old", { supportsChannelLedger: false }),
        ],
        null,
      ),
    ).toBeNull();
    const connected = environment("b");
    expect(
      pickMobileGoatBotEnvironment([environment("a", { connected: false }), connected], null),
    ).toBe(connected);
  });
});

describe("mobile GOAT Bot workspace navigation", () => {
  it("recognizes every detail descendant above Home", () => {
    for (const child of ["Thread", "ThreadFile", "ThreadFiles", "ThreadReview"]) {
      const routes = [{ name: "Home" }, { name: "Thread" }, { name: child }];
      expect(mobileGoatBotDetailOpen({ routes, index: 2 })).toBe(true);
      expect(mobileGoatBotDetailOpen({ routes, index: 0 })).toBe(false);
    }
  });
  it("recognizes a cold-linked detail without Home", () => {
    expect(mobileGoatBotDetailOpen({ routes: [{ name: "ThreadFile" }], index: 0 })).toBe(true);
    expect(mobileGoatBotDetailOpen({ routes: [{ name: "Home" }], index: 0 })).toBe(false);
  });
  it("keeps the bot visible under form sheets and transparent envelopes", () => {
    expect(mobileGoatBotWorkspaceVisible([])).toBe(true);
    expect(mobileGoatBotWorkspaceVisible(["formSheet"])).toBe(true);
    expect(mobileGoatBotWorkspaceVisible(["formSheet", "transparentModal"])).toBe(true);
  });
  it("suspends the bot under full-screen overlays, including one above a sheet", () => {
    expect(mobileGoatBotWorkspaceVisible(["fullScreenModal"])).toBe(false);
    expect(mobileGoatBotWorkspaceVisible(["formSheet", "fullScreenModal"])).toBe(false);
    expect(mobileGoatBotWorkspaceVisible(["modal"])).toBe(false);
    expect(mobileGoatBotWorkspaceVisible(["fullScreenModal", "formSheet"])).toBe(false);
  });
});
