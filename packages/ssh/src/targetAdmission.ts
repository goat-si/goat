import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import type * as KeyedLock from "@goat/shared/KeyedLock";
import * as Effect from "effect/Effect";

import { targetConnectionKey } from "./command.ts";
import { SshLaunchError } from "./errors.ts";

export interface RequestTicket {
  readonly key: string;
  readonly sequence: number;
}

/**
 * Admission to one SSH target: request ordering between ensure and disconnect, and the per-target
 * lock with a count of waiting users so ready-only requests can refuse instead of queueing.
 * One per manager, around that manager's target locks.
 */
export function makeTargetAdmission(targetLocks: KeyedLock.KeyedLock<string>) {
  // Ensure and disconnect requests for one target are ordered by arrival. Both
  // resolve the alias before taking the target lock, so a reconnect sent after a
  // disconnect can reach the lock first. Tickets let each request see whether a
  // newer one has replaced its intent: a disconnect yields to any newer request,
  // and an ensure yields to a newer disconnect.
  let requestSequence = 0;
  const latestRequest = new Map<string, number>();
  const latestDisconnect = new Map<string, number>();
  const takeRequestTicket = (target: DesktopSshEnvironmentTarget, kind: "ensure" | "disconnect") =>
    Effect.sync((): RequestTicket => {
      const key = targetConnectionKey(target);
      const sequence = ++requestSequence;
      latestRequest.set(key, sequence);
      if (kind === "disconnect") latestDisconnect.set(key, sequence);
      return { key, sequence };
    });
  const disconnectSuperseded = (ticket: RequestTicket) =>
    latestRequest.get(ticket.key) !== ticket.sequence;
  const ensureSuperseded = (ticket: RequestTicket) =>
    (latestDisconnect.get(ticket.key) ?? 0) > ticket.sequence;
  const lockUsers = new Map<string, number>();
  const releaseLockUser = (key: string) =>
    Effect.sync(() => {
      const count = lockUsers.get(key) ?? 0;
      if (count <= 1) lockUsers.delete(key);
      else lockUsers.set(key, count - 1);
    });
  // Count admission before any yield, so ready-only requests never queue behind installation.
  const withTargetLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        lockUsers.set(key, (lockUsers.get(key) ?? 0) + 1);
      }),
      () => targetLocks.withLock(key, effect),
      () => releaseLockUser(key),
    );
  const notReady = (target: DesktopSshEnvironmentTarget) =>
    new SshLaunchError({
      message: `Call goat_ssh_host_prepare for ${target.alias}, then call goat_ssh_host_status until setup completes; retry goat_provider_diagnose.`,
      stdout: "",
    });
  const withIdleTargetLock = <A, E, R>(
    key: string,
    target: DesktopSshEnvironmentTarget,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (lockUsers.has(key)) return false;
        lockUsers.set(key, 1);
        return true;
      }),
      (acquired): Effect.Effect<A, E | SshLaunchError, R> =>
        acquired ? targetLocks.withLock(key, effect) : Effect.fail(notReady(target)),
      (acquired) => (acquired ? releaseLockUser(key) : Effect.void),
    );
  return {
    latestRequest,
    takeRequestTicket,
    disconnectSuperseded,
    ensureSuperseded,
    withTargetLock,
    notReady,
    withIdleTargetLock,
  };
}
