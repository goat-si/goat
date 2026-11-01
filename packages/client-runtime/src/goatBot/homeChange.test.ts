import { resolveGoatBotHome, type GoatBotHomeTarget } from "@goat/client-runtime/goatBot/home";
import { EnvironmentId, compareGoatBotHomeClaims } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { planGoatBotHomeChange, writeGoatBotHomeChange } from "./home.ts";

const a = EnvironmentId.make("A"),
  b = EnvironmentId.make("B");
const initial = { environmentId: a, claimedAt: 100, claimId: "initial" };
const target = (environmentId: EnvironmentId): GoatBotHomeTarget => ({
  environmentId,
  connected: true,
  supportsHome: true,
  supportsBot: true,
  settingsLoaded: true,
  home: initial,
});
const input = () => ({
  environmentId: b,
  targets: [target(a), target(b)],
  writableIds: new Set([a, b]),
  currentClaim: initial,
  observedMax: null,
  now: 5,
  randomId: () => "next",
});

describe("GOAT Bot home changes", () => {
  it("moves A to B to A after a partial failure and clock rollback", async () => {
    const toB = planGoatBotHomeChange(input())!;
    const writeB = vi.fn(async (environmentId: EnvironmentId) => environmentId === b);
    expect(await writeGoatBotHomeChange(toB, writeB)).toBe(false);
    expect(writeB.mock.calls.map(([id]) => id)).toEqual([a, b]);
    expect(toB.claim.claimedAt).toBe(101);
    // The settings snapshot may still show A while B's accepted write is in flight.
    const toA = planGoatBotHomeChange({
      ...input(),
      environmentId: a,
      observedMax: toB.claim,
      randomId: () => "back",
    })!;
    expect(toA.claim.claimedAt).toBe(102);
    expect(compareGoatBotHomeClaims(toA.claim, toB.claim)).toBeGreaterThan(0);
    let snapshots = [target(a), { ...target(b), home: toB.claim }];
    expect(
      await writeGoatBotHomeChange(toA, async (id, claim) => {
        snapshots = snapshots.map((entry) =>
          entry.environmentId === id ? { ...entry, home: claim } : entry,
        );
        return true;
      }),
    ).toBe(true);
    expect(resolveGoatBotHome({ targets: snapshots })).toMatchObject({
      state: "claimed",
      claim: toA.claim,
      staleTargetIds: [],
    });
  });
  it("can retry the same selection when no server read back the previous write", async () => {
    const failed = planGoatBotHomeChange(input())!;
    expect(await writeGoatBotHomeChange(failed, async () => false)).toBe(false);
    const retry = planGoatBotHomeChange({
      ...input(),
      observedMax: failed.claim,
      randomId: () => "retry",
    })!;
    expect(retry.claim.environmentId).toBe(b);
    expect(retry.claim.claimedAt).toBe(102);
  });
  it("does not issue a claim to an offline or unauthorized selected computer", () => {
    expect(planGoatBotHomeChange({ ...input(), writableIds: new Set([a]) })).toBeNull();
    expect(
      planGoatBotHomeChange({
        ...input(),
        targets: [target(a), { ...target(b), connected: false }],
      }),
    ).toBeNull();
    expect(planGoatBotHomeChange({ ...input(), environmentId: a })).toBeNull();
  });
  it("writes only to connected supporting writable servers and reports a rejected write", async () => {
    const change = planGoatBotHomeChange({
      ...input(),
      targets: [
        target(a),
        target(b),
        { ...target(EnvironmentId.make("old")), supportsHome: false },
        { ...target(EnvironmentId.make("offline")), connected: false },
        target(EnvironmentId.make("readonly")),
      ],
    })!;
    expect(change.targetIds).toEqual([a, b]);
    const write = vi.fn(async (id: EnvironmentId) => {
      if (id === a) throw new Error("disconnected");
      return true;
    });
    expect(await writeGoatBotHomeChange(change, write)).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
