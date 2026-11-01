import { describe, expect, it } from "@effect/vitest";
import type { HostStatusEntry } from "@goat/contracts";

import {
  deriveConditions,
  emptyContact,
  forgetFailures,
  initialClock,
  isLost,
  isSchedulable,
  isUnreachable,
  observeTick,
  recordOutage,
  recordSample,
  type HostContact,
  type MonitorClock,
} from "./hostHealthModel.ts";

const MIN = 60_000;
const ok: HostStatusEntry = { host: "macmini", reachability: "ok", serverVersion: "1" };
const down: HostStatusEntry = {
  host: "macmini",
  reachability: "unreachable",
  message: "ssh timed out",
};

/** One sample per minute, ticking the monitor clock as the scheduler would in between. */
function run(
  samples: ReadonlyArray<{
    readonly at: number;
    readonly entry: HostStatusEntry;
    readonly suspended?: boolean;
  }>,
) {
  let contact: HostContact = emptyContact;
  let clock: MonitorClock = initialClock;
  for (const { at, entry, suspended } of samples) {
    const ticked = observeTick(clock, at, suspended ?? false);
    clock = ticked.clock;
    if (ticked.woke) contact = forgetFailures(contact);
    if (suspended === true) continue;
    contact = recordSample(contact, entry, at, clock);
  }
  return { contact, clock };
}

const every = (fromMin: number, toMin: number, entry: HostStatusEntry) =>
  Array.from({ length: toMin - fromMin + 1 }, (_, index) => ({
    at: (fromMin + index) * MIN,
    entry,
  }));

const types = (contact: HostContact, now: number) =>
  deriveConditions({ contact, scheduling: null, now }).map((condition) => condition.type);

describe("host conditions", () => {
  it("turns Unreachable after three failed contacts and Lost five minutes later", () => {
    const two = run([...every(0, 0, ok), ...every(1, 2, down)]);
    expect(isUnreachable(two.contact)).toBe(false);
    const three = run([...every(0, 0, ok), ...every(1, 3, down)]);
    expect(types(three.contact, 3 * MIN)).toEqual(["Unreachable"]);
    expect(isLost(three.contact, 7 * MIN)).toBe(false);
    expect(types(three.contact, 8 * MIN)).toEqual(["Unreachable", "Lost"]);
  });

  it("is Ready for three minutes after an answer, then Unknown until the next contact", () => {
    const answered = run(every(0, 0, ok));
    expect(types(answered.contact, 3 * MIN)).toEqual(["Ready"]);
    expect(types(answered.contact, 4 * MIN)).toEqual(["Unknown"]);
    expect(types(emptyContact, 0)).toEqual(["Unknown"]);
    const back = run([...every(0, 10, down), ...every(11, 11, ok)]);
    expect(types(back.contact, 11 * MIN)).toEqual(["Ready"]);
  });

  it("never makes a host Lost across this machine's sleep", () => {
    // Asleep from minute 2 to 62. The tick gap marks the wake; SSH is still reconnecting for a
    // few minutes after it, and those failures fall in the grace window.
    const woke = run([...every(0, 2, down), ...every(62, 66, down)]);
    expect(woke.clock.wokeAt).toBe(62 * MIN);
    expect(woke.contact.failures).toBe(0);
    expect(isLost(woke.contact, 66 * MIN)).toBe(false);
    const suspended = run(every(1, 20, down).map((sample) => ({ ...sample, suspended: true })));
    expect(suspended.contact.failures).toBe(0);
  });

  it("counts a launch-watch outage only after the wake grace and the last answer", () => {
    const clock: MonitorClock = { lastTickAt: 70 * MIN, quietUntil: 67 * MIN, wokeAt: 62 * MIN };
    const outage = (since: number, failures: number) => ({
      since,
      episode: 1,
      failures,
      notified: true,
      nextRetryAt: since,
      lastError: "unreachable",
    });
    expect(recordOutage(emptyContact, outage(30 * MIN, 5), 70 * MIN, clock).failures).toBe(0);
    expect(recordOutage(emptyContact, outage(68 * MIN, 4), 70 * MIN, clock)).toMatchObject({
      failures: 4,
      unreachableSince: 70 * MIN,
    });
    const answered = { ...emptyContact, lastOkAt: 69 * MIN };
    expect(recordOutage(answered, outage(68 * MIN, 4), 70 * MIN, clock).failures).toBe(0);
  });

  it("warns about versions and quotas, and only cordon, drain and outages block placement", () => {
    const sample = {
      ...ok,
      versionMismatch: true as const,
      message: "macmini runs GOAT 0",
      metrics: {
        quotas: [
          {
            instanceId: "codex",
            driver: "codex",
            fromCache: false,
            limits: {
              checkedAt: "2026-10-20T00:00:00.000Z",
              windows: [
                {
                  id: "primary",
                  kind: "session",
                  label: "5h",
                  usedPercent: 100,
                  resetsAt: "2099-01-01T00:00:00.000Z",
                },
              ],
            },
          },
        ],
      },
    } as unknown as HostStatusEntry;
    const contact = { ...emptyContact, lastOkAt: 0, sample };
    const warnings = deriveConditions({ contact, scheduling: null, now: MIN });
    expect(warnings.map((condition) => [condition.type, condition.instanceId])).toEqual([
      ["Ready", undefined],
      ["VersionMismatch", undefined],
      ["QuotaExhausted", "codex"],
    ]);
    expect(isSchedulable(warnings)).toBe(true);
    const drained = deriveConditions({
      contact,
      scheduling: {
        cordoned: true,
        draining: true,
        reason: null,
        changedAt: "2026-10-20T00:00:00.000Z",
      },
      now: MIN,
    });
    expect(drained.map((condition) => condition.type)).toEqual(
      expect.arrayContaining(["Cordoned", "Draining"]),
    );
    expect(isSchedulable(drained)).toBe(false);
    // A host that cannot work with this machine takes no work; compatible builds raise nothing.
    const incompatible = { ...contact, sample: { ...ok, compatibility: "incompatible" as const } };
    expect(
      isSchedulable(deriveConditions({ contact: incompatible, scheduling: null, now: MIN })),
    ).toBe(false);
    const compatible = {
      ...contact,
      sample: { ...ok, versionMismatch: true as const, compatibility: "compatible" as const },
    };
    expect(types(compatible, MIN)).toEqual(["Ready"]);
  });
});

describe("quota conditions", () => {
  const quotaSample = (limits: Record<string, unknown>) =>
    ({
      ...ok,
      metrics: {
        quotas: [
          {
            instanceId: "claude",
            driver: "claudeAgent",
            fromCache: false,
            limits: { checkedAt: "2026-10-20T00:00:00.000Z", ...limits },
          },
        ],
      },
    }) as unknown as HostStatusEntry;
  const conditionsFor = (limits: Record<string, unknown>) =>
    deriveConditions({
      contact: { ...emptyContact, lastOkAt: 0, sample: quotaSample(limits) },
      scheduling: null,
      now: MIN,
    })
      .filter((condition) => condition.type === "QuotaExhausted")
      .map((condition) => condition.instanceId);

  it("raises a host-wide quota condition only for unscoped exhaustion", () => {
    const future = "2099-01-01T00:00:00.000Z";
    expect(
      conditionsFor({
        windows: [
          {
            id: "opus",
            kind: "weekly",
            label: "Opus weekly",
            usedPercent: 100,
            scopeModel: "family:opus",
            resetsAt: future,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      conditionsFor({
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 100,
            exhausted: false,
            resetsAt: future,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      conditionsFor({
        windows: [],
        availability: [
          { id: "availability", label: "Availability", exhausted: true, resetsAt: future },
        ],
      }),
    ).toEqual(["claude"]);
  });
});
