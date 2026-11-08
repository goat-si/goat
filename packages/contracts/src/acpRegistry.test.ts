import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AcpRegistryListSessionsInput,
  AcpRegistryListSessionsResult,
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "./acpRegistry.ts";

const decodeUninstallInput = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallInput);
const decodeUninstallResult = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallResult);
const decodeListInput = Schema.decodeUnknownSync(AcpRegistryListSessionsInput);
const decodeListResult = Schema.decodeUnknownSync(AcpRegistryListSessionsResult);
const listIdentity = { instanceId: "acp-fixture", projectId: "project-fixture" };
const listResult = {
  sessions: [],
  nextCursor: null,
  canLoad: true,
  canResume: false,
  canDelete: false,
};

describe("ACP Registry contracts", () => {
  it("accepts only official Registry icon URLs and safe agent IDs", () => {
    expect(officialAcpRegistryIconUrlForAgentId("antigravity-acp")).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg",
    );
    expect(officialAcpRegistryIconUrlForAgentId("../antigravity-acp")).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg");
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com.evil/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://user@cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
  });

  it("decodes managed binary uninstall payloads and rejects unsafe agent IDs", () => {
    expect(decodeUninstallInput({ agentId: "  example-agent  " })).toEqual({
      agentId: "example-agent",
    });
    expect(decodeUninstallResult({ agentId: "example-agent", removed: false })).toEqual({
      agentId: "example-agent",
      removed: false,
    });
    expect(() => decodeUninstallInput({ agentId: "../example-agent" })).toThrow();
  });

  it("accepts a continuation token and keeps it absent rather than null", () => {
    const token = "a".repeat(16);
    expect(decodeListInput({ ...listIdentity, continuation: token }).continuation).toBe(token);
    expect(decodeListInput(listIdentity).continuation).toBeUndefined();
    expect(decodeListResult({ ...listResult, continuation: "B".repeat(64) }).continuation).toBe(
      "B".repeat(64),
    );
    expect(decodeListResult(listResult).continuation).toBeUndefined();
  });

  it("rejects malformed continuation tokens", () => {
    expect(() => decodeListInput({ ...listIdentity, continuation: "a".repeat(15) })).toThrow();
    expect(() => decodeListInput({ ...listIdentity, continuation: "a".repeat(65) })).toThrow();
    expect(() => decodeListInput({ ...listIdentity, continuation: "bad token-value!!" })).toThrow();
    expect(() => decodeListInput({ ...listIdentity, continuation: null })).toThrow();
    expect(() => decodeListResult({ ...listResult, continuation: "has space" })).toThrow();
  });
});
