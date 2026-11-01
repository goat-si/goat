import { describe, expect, it } from "vite-plus/test";

import {
  compareRuntimeProtocols,
  hostCompatibilityOf,
  ownRuntimeProtocolRanges,
} from "./sshRuntimeProtocol.ts";

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

describe("hostCompatibilityOf", () => {
  const speaks = ownRuntimeProtocolRanges(1001);
  const ranges = (ssh: [number, number], orchestration: [number, number]) => ({
    ssh: { min: ssh[0], max: ssh[1] },
    orchestration: { min: orchestration[0], max: orchestration[1] },
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly protocol: Parameters<typeof hostCompatibilityOf>[1]["protocol"];
    readonly expected: ReturnType<typeof hostCompatibilityOf>;
  }> = [
    {
      name: "the same single protocols",
      protocol: ranges([1001, 1001], [1001, 1001]),
      expected: { compatibility: "compatible", update: null },
    },
    {
      name: "a newer host that still serves this protocol",
      protocol: ranges([1001, 1002], [1000, 1003]),
      expected: { compatibility: "compatible", update: null },
    },
    {
      name: "an older host at the bottom of its range",
      protocol: ranges([1001, 1001], [1001, 1001]),
      expected: { compatibility: "compatible", update: null },
    },
    {
      name: "a host whose orchestration range ends below this protocol",
      protocol: ranges([1001, 1001], [1, 1000]),
      expected: { compatibility: "incompatible", update: "host" },
    },
    {
      name: "a host whose SSH range ends below this protocol",
      protocol: ranges([1, 1000], [1001, 1001]),
      expected: { compatibility: "incompatible", update: "host" },
    },
    {
      name: "a host that no longer serves this protocol",
      protocol: ranges([1001, 1001], [1002, 1004]),
      expected: { compatibility: "incompatible", update: "this-machine" },
    },
    {
      name: "a host too old on one axis and too new on the other",
      protocol: ranges([1, 1000], [1002, 1002]),
      expected: { compatibility: "incompatible", update: "host" },
    },
    {
      name: "a host that reports no ranges",
      protocol: undefined,
      expected: { compatibility: "degraded", update: "host" },
    },
    {
      name: "a host that reports only one axis",
      protocol: { orchestration: { min: 1001, max: 1001 } },
      expected: { compatibility: "degraded", update: "host" },
    },
    {
      name: "a host with an inverted range",
      protocol: ranges([1001, 1001], [1003, 1001]),
      expected: { compatibility: "degraded", update: "host" },
    },
    {
      name: "a host with a non-positive range",
      protocol: ranges([0, 1001], [1001, 1001]),
      expected: { compatibility: "degraded", update: "host" },
    },
  ];
  it.each(cases)("$name", ({ protocol, expected }) => {
    expect(hostCompatibilityOf(speaks, protocol === undefined ? {} : { protocol })).toEqual(
      expected,
    );
  });
});
