import { describe, expect, it } from "vite-plus/test";

import { compareRuntimeProtocols, ownRuntimeProtocolRanges } from "./sshRuntimeProtocol.ts";

const client = { ssh: { min: 1001, max: 1003 }, orchestration: { min: 1001, max: 1001 } };

describe("compareRuntimeProtocols", () => {
  it("attaches when both ranges overlap, whatever the build versions", () => {
    expect(
      compareRuntimeProtocols(client, {
        protocol: { ssh: { min: 1003, max: 1005 }, orchestration: { min: 1000, max: 1001 } },
      }),
    ).toBe("compatible");
    expect(
      compareRuntimeProtocols(ownRuntimeProtocolRanges(1001), {
        protocol: ownRuntimeProtocolRanges(1001),
      }),
    ).toBe("compatible");
  });

  it("names which side is too old", () => {
    expect(
      compareRuntimeProtocols(client, {
        sshRuntimeProtocolVersion: 1000,
        orchestrationProtocolVersion: 1001,
      }),
    ).toBe("update-required");
    expect(
      compareRuntimeProtocols(client, {
        protocol: { ssh: { min: 1004, max: 1004 }, orchestration: { min: 1001, max: 1001 } },
      }),
    ).toBe("client-too-old");
    // A server too old on one axis needs updating even if it is ahead on the other.
    expect(
      compareRuntimeProtocols(client, {
        sshRuntimeProtocolVersion: 1000,
        orchestrationProtocolVersion: 1002,
      }),
    ).toBe("update-required");
  });

  it("falls back to advertised integers and is unknown without them", () => {
    expect(
      compareRuntimeProtocols(client, {
        sshRuntimeProtocolVersion: 1002,
        orchestrationProtocolVersion: 1001,
      }),
    ).toBe("compatible");
    expect(compareRuntimeProtocols(client, { sshRuntimeProtocolVersion: 1002 })).toBe("unknown");
    expect(
      compareRuntimeProtocols(client, {
        protocol: { ssh: { min: 5, max: 1 }, orchestration: { min: 1001, max: 1001 } },
      }),
    ).toBe("unknown");
  });
});
