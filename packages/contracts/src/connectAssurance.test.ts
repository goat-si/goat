import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ConnectSessionAssurance, isConnectAssuranceFresh } from "./connectAssurance.ts";

const assurance = {
  policyVersion: 1 as const,
  source: "clerk-session" as const,
  userId: "user-1",
  sessionId: "session-1",
  firstVerifiedAtFloor: 1000,
  secondVerifiedAtFloor: 1020,
  checkedAt: 1080,
  authGeneration: 1,
};
const decode = Schema.decodeUnknownOption(ConnectSessionAssurance);

describe("Connect assurance contract", () => {
  it("preserves factor bounds and expires at the exact conservative ten-minute boundary", () => {
    expect(decode(assurance)._tag).toBe("Some");
    expect(isConnectAssuranceFresh(assurance, 1599)).toBe(true);
    expect(isConnectAssuranceFresh(assurance, 1600)).toBe(false);
    expect(isConnectAssuranceFresh(assurance, 1079)).toBe(false);
    expect(isConnectAssuranceFresh({ ...assurance, checkedAt: 1500 }, 1600)).toBe(false);
  });
  it.each([
    {},
    { ...assurance, policyVersion: undefined },
    { ...assurance, policyVersion: 0 },
    { ...assurance, source: "clerk-oauth" },
    { ...assurance, secondVerifiedAtFloor: -1 },
  ])("rejects legacy or unsupported strength %j", (value) => {
    expect(decode(value)._tag).toBe("None");
  });
});
