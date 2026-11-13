import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { SshConnectionTarget } from "./model.ts";
import { penRouteConnectionId } from "./routes.ts";
import { decide } from "./penLiveSet.ts";

const meshId = "a".repeat(26);
const node = (n: number) => String.fromCharCode(97 + n).repeat(26);
const entries = Array.from({ length: 17 }, (_, n) => ({
  enabled: true,
  target: new SshConnectionTarget({
    environmentId: EnvironmentId.make(`env-${n}`),
    connectionId: penRouteConnectionId(meshId, node(n)),
    label: `env-${n}`,
  }),
  profile: Option.none(),
}));
const membership = {
  kind: "ready" as const,
  seq: 1,
  meshId,
  selfNodeId: node(99),
  members: entries.map((_, n) => ({
    nodeId: node(n),
    name: `${n}`,
    noisePub: `${n}`,
    online: true,
    route: {
      kind: "trusted" as const,
      target: { alias: `${n}`, hostname: `${n}`, username: null, port: null },
      revision: "1",
    },
  })),
};

describe("Pen live selection", () => {
  it("holds the seventeenth online environment and opens a recent choice first", () => {
    const initial = decide({ entries, membership, recency: [], onboarding: new Set(), limit: 16 });
    expect(initial.live.size).toBe(16);
    expect(initial.waiting.has(EnvironmentId.make("env-16"))).toBe(true);
    const next = decide({
      entries,
      membership,
      recency: [EnvironmentId.make("env-16")],
      onboarding: new Set(),
      limit: 16,
    });
    expect(next.live.has(EnvironmentId.make("env-16"))).toBe(true);
    expect(next.waiting.has(EnvironmentId.make("env-15"))).toBe(true);
  });
  it("holds offline entries without consuming a slot", () => {
    const result = decide({
      entries,
      membership: {
        ...membership,
        members: membership.members.map((member, n) =>
          n === 0 ? { ...member, online: false } : member,
        ),
      },
      recency: [],
      onboarding: new Set(),
      limit: 16,
    });
    expect(result.offline.has(EnvironmentId.make("env-0"))).toBe(true);
    expect(result.live.has(EnvironmentId.make("env-16"))).toBe(true);
  });
});

it("reserves capacity for onboarding and never holds an entry with a non-Pen route", () => {
  const mixed = {
    ...entries[0]!,
    alternateRoutes: [
      {
        target: new SshConnectionTarget({
          environmentId: entries[0]!.target.environmentId,
          connectionId: "ssh:ordinary",
          label: "ordinary",
        }),
        profile: Option.none(),
      },
    ],
  };
  const result = decide({
    entries: [mixed, ...entries.slice(1)],
    membership,
    recency: [],
    onboarding: new Set([node(20)]),
    limit: 16,
  });
  expect(result.live.size).toBe(15);
  expect(result.live.has(mixed.target.environmentId)).toBe(false);
  expect(result.offline.has(mixed.target.environmentId)).toBe(false);
  expect(result.waiting.has(mixed.target.environmentId)).toBe(false);
  expect(result.waiting.has(EnvironmentId.make("env-16"))).toBe(true);
});
