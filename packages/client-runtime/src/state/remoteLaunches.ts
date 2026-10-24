import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  RemoteLaunch,
  ScopedThreadRef,
  ThreadId,
} from "@goat/contracts";

import { scopeThreadRef } from "../environment/scoped.ts";

export interface RemoteLaunchShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly source: Pick<OrchestrationV2ThreadShell, "launchedBy">;
}

export interface PresentedRemoteLaunch {
  readonly launch: RemoteLaunch;
  /** The thread in an environment this client is connected to, when it is loaded. */
  readonly ref: ScopedThreadRef | null;
  readonly title: string | null;
}

export interface RemoteLaunchHostGroup {
  /** SSH alias on the dispatching environment. */
  readonly host: string;
  /** The host's environment, learned from a thread this client has loaded there. */
  readonly environmentId: EnvironmentId | null;
  readonly launches: ReadonlyArray<PresentedRemoteLaunch>;
}

/**
 * Finds a remote thread among the shells this client holds. Thread ids are
 * random, but a copied database can repeat one, so a shell whose launcher is
 * the dispatching environment wins, and an id that stays ambiguous resolves
 * to nothing.
 */
export function findRemoteShell<Shell extends RemoteLaunchShell>(
  shells: ReadonlyArray<Shell>,
  dispatcherEnvironmentId: EnvironmentId,
  threadId: ThreadId,
): Shell | null {
  const candidates = shells.filter(
    (shell) => shell.id === threadId && shell.environmentId !== dispatcherEnvironmentId,
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  const launchedHere = candidates.filter(
    (shell) => shell.source.launchedBy?.environmentId === dispatcherEnvironmentId,
  );
  return launchedHere.length === 1 ? launchedHere[0]! : null;
}

/**
 * Groups a dispatching environment's remote launches by host, in the order
 * the server listed them (newest first), and resolves each one this client can
 * open. A host whose threads none resolve is one the client is not connected to.
 */
export function presentRemoteLaunches(input: {
  readonly dispatcherEnvironmentId: EnvironmentId;
  readonly launches: ReadonlyArray<RemoteLaunch>;
  readonly shells: ReadonlyArray<RemoteLaunchShell>;
}): ReadonlyArray<RemoteLaunchHostGroup> {
  const groups = new Map<
    string,
    { environmentId: EnvironmentId | null; launches: Array<PresentedRemoteLaunch> }
  >();
  for (const launch of input.launches) {
    const shell =
      launch.threadId === null
        ? null
        : findRemoteShell(input.shells, input.dispatcherEnvironmentId, launch.threadId);
    const group = groups.get(launch.host) ?? { environmentId: null, launches: [] };
    groups.set(launch.host, group);
    group.environmentId ??= shell?.environmentId ?? null;
    group.launches.push({
      launch,
      ref: shell === null ? null : scopeThreadRef(shell.environmentId, shell.id),
      title: shell?.title ?? launch.title,
    });
  }
  return [...groups].map(([host, group]) => ({ host, ...group }));
}
