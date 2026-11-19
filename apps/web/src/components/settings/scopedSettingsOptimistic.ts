import type { EnvironmentId, ServerSettings } from "@goat/contracts";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";
import type { ScopedSettingsEnvironment, ScopedSettingsPlan } from "./scopedSettings";

type Planner = (environments: readonly ScopedSettingsEnvironment[]) => ScopedSettingsPlan;
export interface PendingScopedWrite {
  readonly save: object;
  readonly environmentId: EnvironmentId;
  readonly environments: readonly ScopedSettingsEnvironment[];
  readonly plan: Planner;
  readonly saved?: ServerSettings;
}

export const pendingScopedWritesAtom = Atom.make<readonly PendingScopedWrite[]>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-settings:pending-scoped-writes"),
);

export function settlePendingScopedWrite(
  writes: readonly PendingScopedWrite[],
  save: object,
  environmentId: EnvironmentId,
  saved?: ServerSettings,
): readonly PendingScopedWrite[] {
  if (saved === undefined) {
    return writes.filter((write) => write.save !== save || write.environmentId !== environmentId);
  }
  return writes.map((write) =>
    write.environmentId === environmentId && (write.save === save || write.saved !== undefined)
      ? { ...write, saved }
      : write,
  );
}

export function reconcilePendingScopedWrites(
  writes: readonly PendingScopedWrite[],
  environments: readonly ScopedSettingsEnvironment[],
): readonly PendingScopedWrite[] {
  const remaining = writes.filter((write) => {
    const current = environments.find(
      (environment) => environment.environmentId === write.environmentId,
    )?.serverConfig?.settings;
    return (
      write.saved === undefined || current === undefined || !Equal.equals(current, write.saved)
    );
  });
  return remaining.length === writes.length ? writes : remaining;
}

export function applyPendingScopedWrites<T extends ScopedSettingsEnvironment>(
  environments: readonly T[],
  writes: readonly PendingScopedWrite[],
): readonly T[] {
  if (writes.length === 0) return environments;
  return environments.map((environment) => {
    const config = environment.serverConfig;
    if (config === null) return environment;
    const settings = writes.reduce((current, write) => {
      if (
        write.environmentId !== environment.environmentId ||
        (write.saved !== undefined && Equal.equals(write.saved, config.settings))
      )
        return current;
      const replanned = write.plan(
        write.environments.map((candidate) =>
          candidate.environmentId === environment.environmentId && candidate.serverConfig
            ? { ...candidate, serverConfig: { ...candidate.serverConfig, settings: current } }
            : candidate,
        ),
      );
      const patch = replanned.serverWrites.find(
        (candidate) => candidate.environmentId === environment.environmentId,
      )?.patch;
      return patch ? applyServerSettingsPatch(current, patch) : current;
    }, config.settings);
    return settings === config.settings
      ? environment
      : { ...environment, serverConfig: { ...config, settings } };
  });
}
