import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  supportsMemoryProtocol,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "./environment.ts";
import { EnvironmentHttpApi } from "./environmentHttp.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("keeps memory browsing extensions optional for older environments", () => {
    for (const value of [undefined, false, true]) {
      const memory = decodeDescriptor({
        ...descriptor,
        capabilities: {
          memory: {
            protocolVersion: 1,
            ...(value === undefined ? {} : { resolutionInputs: value, retainedLocalSpace: value }),
          },
        },
      }).capabilities.memory!;
      expect(memory.resolutionInputs).toBe(value);
      expect(memory.retainedLocalSpace).toBe(value);
    }
  });
  it("keeps legacy SSH signals absent and preserves explicit integers", () => {
    expect(decodeDescriptor(descriptor).sshRuntimeProtocolVersion).toBeUndefined();
    expect(
      decodeDescriptor({ ...descriptor, sshRuntimeProtocolVersion: 1 }).sshRuntimeProtocolVersion,
    ).toBe(1);
    for (const value of ["1", 1.5, null]) {
      expect(() => decodeDescriptor({ ...descriptor, sshRuntimeProtocolVersion: value })).toThrow();
    }
  });

  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });

  it("treats a missing automatic server updates capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.automaticServerUpdates).toBeUndefined();
  });

  it("preserves an advertised automatic server updates capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, automaticServerUpdates: true },
      }).capabilities.automaticServerUpdates,
    ).toBe(true);
  });

  it("treats the channel capabilities as off unless a server says otherwise", () => {
    for (const key of ["channelLedger", "slackChannel"] as const) {
      expect(decodeDescriptor(descriptor).capabilities[key]).toBeUndefined();
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, [key]: false },
        }).capabilities[key],
      ).toBe(false);
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, [key]: true },
        }).capabilities[key],
      ).toBe(true);
    }
  });
});

describe("GOAT orchestration protocol", () => {
  it("derives the HTTP protocol text from the wire version", () => {
    expect(ORCHESTRATION_PROTOCOL_VERSION_TEXT).toBe(String(ORCHESTRATION_PROTOCOL_VERSION));
  });

  it("rejects upstream header 2 on authenticated orchestration endpoints", () => {
    for (const endpoint of Object.values(EnvironmentHttpApi.groups.orchestration.endpoints)) {
      const headers = endpoint.headers;
      expect(headers).toBeDefined();
      if (headers === undefined) throw new Error("Missing protocol headers");
      const acceptsHeaders = Schema.is(headers);
      expect(acceptsHeaders({ [ORCHESTRATION_PROTOCOL_HEADER]: "2" })).toBe(false);
      expect(
        acceptsHeaders({ [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT }),
      ).toBe(true);
    }
  });
});

describe("memory advertisement", () => {
  it("decodes descriptor without memory advertisement", () => {
    const c = decodeDescriptor(descriptor).capabilities;
    expect(c.memory).toBeUndefined();
    expect(supportsMemoryProtocol(c)).toBe(false);
  });
  it("decodes future memory protocol but disables support", () => {
    const c = decodeDescriptor({
      ...descriptor,
      capabilities: { memory: { protocolVersion: 2 }, memoryHubProtocolVersion: 2 },
    }).capabilities;
    expect(c.memory?.protocolVersion).toBe(2);
    expect(supportsMemoryProtocol(c)).toBe(false);
  });
  it("enables only protocol one", () => {
    for (const protocolVersion of [0, 1, 2]) {
      const c = decodeDescriptor({
        ...descriptor,
        capabilities: { memory: { protocolVersion } },
      }).capabilities;
      expect(supportsMemoryProtocol(c)).toBe(protocolVersion === 1);
      expect(c.memory?.hub).toBeUndefined();
      expect(c.memory?.importProvider).toBeUndefined();
    }
  });
});
