import type { DisposableRecord } from "./disposableClass.ts";

/** What a kept-machine path is about to route to: an alias, the environment it reached, the key it offered. */
export interface RouteClaim {
  readonly alias?: string;
  readonly environmentId?: string | null;
  readonly hostKeyFingerprint?: string;
}

export interface DisposableClaim {
  readonly attachId: string;
  readonly nodeId: string;
  readonly by: "alias" | "environment" | "host_key";
}

/**
 * Design section 6, Disposable: Pen only. A path that adds or moves a route refuses when its alias,
 * the environment it reached or the sshd key it was offered belongs to an open disposable record.
 * Only records refuse: an empty or unreadable table reads as kept (design section 1, Fail safe).
 */
export const claimedBy = (
  records: ReadonlyArray<DisposableRecord>,
  claim: RouteClaim,
): DisposableClaim | undefined => {
  const alias = claim.alias?.toLowerCase();
  for (const record of records) {
    if (record.final) continue;
    const found = (by: DisposableClaim["by"]) => ({
      attachId: record.attachId,
      nodeId: record.nodeId,
      by,
    });
    if (alias !== undefined && alias === "pen-" + record.nodeId.toLowerCase())
      return found("alias");
    if (
      claim.environmentId !== undefined &&
      claim.environmentId !== null &&
      claim.environmentId === record.environmentId
    )
      return found("environment");
    if (claim.hostKeyFingerprint !== undefined && claim.hostKeyFingerprint === record.sshdPin)
      return found("host_key");
  }
  return undefined;
};

const BY: Record<DisposableClaim["by"], string> = {
  alias: "its Pen alias",
  environment: "the GOAT environment it reached",
  host_key: "the SSH host key it offered",
};

/** The refusal every guarded path gives, naming the record and the way out. */
export const refusalText = (claim: DisposableClaim | undefined, target: string) =>
  claim === undefined
    ? ""
    : target +
      " is a disposable machine (attach " +
      claim.attachId +
      ", matched by " +
      BY[claim.by] +
      "): GOAT reaches it only through its own Pen route, so no other route or link may name it. Detach it in Settings → Hub first, or remove it from Pen with pen revoke.";
