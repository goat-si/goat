import type { OpenCodexInventorySnapshot, OpenCodexUpdateStatus } from "@goat/contracts";

/** OpenCodex's latest channel publishes plain releases; previews never update automatically. */
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/u;

export const isStableOpenCodexVersion = (version: string | undefined): version is string =>
  version !== undefined && STABLE.test(version);

/** Orders two stable versions; callers check `isStableOpenCodexVersion` first. */
function compareOpenCodexVersions(a: string, b: string): number {
  const left = STABLE.exec(a)!.slice(1).map(Number);
  const right = STABLE.exec(b)!.slice(1).map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

export interface OpenCodexUpdateMember {
  /** null is the coordinating machine: the Home, or a standalone install. */
  readonly alias: string | null;
  /** Undefined when the device could not be read. */
  readonly snapshot: OpenCodexInventorySnapshot | undefined;
  /** Undefined when activity could not be read, which counts as busy. */
  readonly runningTurns: number | undefined;
}

export interface OpenCodexUpdateStep {
  readonly alias: string | null;
  readonly fromVersion: string;
}

export type OpenCodexUpdatePlan = Pick<
  OpenCodexUpdateStatus,
  "decision" | "reason" | "waitingOn" | "advisories"
> & {
  readonly targetVersion?: string;
  readonly steps: ReadonlyArray<OpenCodexUpdateStep>;
};

type MemberVerdict =
  | "eligible"
  | "current"
  | "adopted"
  | "unreachable"
  | "unpublished-version"
  | "previous-failure"
  | "service-unknown"
  | "restart-unobservable";

export const failedTargetKey = (alias: string | null) => alias ?? "";

function verdictOf(
  member: OpenCodexUpdateMember,
  target: string,
  failedTargets: Readonly<Record<string, string>>,
): MemberVerdict {
  const snapshot = member.snapshot;
  if (!snapshot?.runtime.healthy) return "unreachable";
  const version = snapshot.runtime.version;
  if (!isStableOpenCodexVersion(version)) return "unpublished-version";
  if (compareOpenCodexVersions(target, version) <= 0) return "current";
  if (snapshot.ownership !== "managed") return "adopted";
  if (failedTargets[failedTargetKey(member.alias)] === target) return "previous-failure";
  // Without OpenCodex's service status (OCX-10) a restart's effect cannot be predicted.
  if (!snapshot.service.available || snapshot.service.running !== true) return "service-unknown";
  // Probation detects a crash-and-restart only through `/healthz` pid and uptime.
  if (
    snapshot.parityEvidence?.startedAt === undefined ||
    snapshot.parityEvidence.processId === undefined
  )
    return "restart-unobservable";
  return "eligible";
}

/**
 * One idle window for a Home and its linked Children (design §6, ADR-0019). Only a newer release
 * on the channel moves anything; drift between members never does. A Child never runs ahead of
 * its Home, and the Home moves only when every Child can follow in the same window, because which
 * Child versions a new Home still serves is not published (OCX-8).
 */
export function planOpenCodexUpdate(input: {
  readonly home: OpenCodexUpdateMember;
  readonly children: ReadonlyArray<OpenCodexUpdateMember>;
  readonly targetVersion: string | undefined;
  readonly failedTargets: Readonly<Record<string, string>>;
}): OpenCodexUpdatePlan {
  const target = input.targetVersion;
  const result = (
    reason: string,
    rest: Partial<OpenCodexUpdatePlan> = {},
  ): OpenCodexUpdatePlan => ({
    decision: "none",
    reason,
    waitingOn: [],
    advisories: [],
    steps: [],
    ...(target === undefined ? {} : { targetVersion: target }),
    ...rest,
  });
  if (!isStableOpenCodexVersion(target)) return result("no-target");

  const verdict = (member: OpenCodexUpdateMember) => verdictOf(member, target, input.failedTargets);
  const members = [input.home, ...input.children];
  const advisories = members.flatMap((member) =>
    verdict(member) === "adopted"
      ? [{ alias: member.alias, version: member.snapshot!.runtime.version!, targetVersion: target }]
      : [],
  );
  const homeVerdict = verdict(input.home);
  const homeMoves = homeVerdict === "eligible";
  const homeReady = homeMoves || homeVerdict === "current";
  const eligibleChildren = input.children.filter((child) => verdict(child) === "eligible");

  if (homeMoves) {
    const blockers = input.children.filter((child) => {
      const value = verdict(child);
      return value !== "eligible" && value !== "current";
    });
    if (blockers.length > 0)
      return result("child-cannot-follow", {
        decision: "wait",
        waitingOn: blockers.map(({ alias }) => alias),
        advisories,
      });
  }
  const moving = [...(homeMoves ? [input.home] : []), ...(homeReady ? eligibleChildren : [])];
  if (moving.length === 0)
    return result(
      eligibleChildren.length > 0
        ? "home-behind"
        : homeVerdict === "previous-failure" ||
            homeVerdict === "unpublished-version" ||
            homeVerdict === "unreachable" ||
            homeVerdict === "service-unknown" ||
            homeVerdict === "restart-unobservable"
          ? homeVerdict
          : advisories.length > 0
            ? "advice-only"
            : "up-to-date",
      { advisories },
    );

  // Restarting the Home interrupts every Child's routing, so the whole pair must be idle.
  const affected = homeMoves ? members : moving;
  const busy = affected.filter((member) => member.runningTurns !== 0);
  if (busy.length > 0)
    return result("busy", {
      decision: "wait",
      waitingOn: busy.map(({ alias }) => alias),
      advisories,
    });
  return result("eligible", {
    decision: "update",
    advisories,
    steps: moving.map((member) => ({
      alias: member.alias,
      fromVersion: member.snapshot!.runtime.version!,
    })),
  });
}
