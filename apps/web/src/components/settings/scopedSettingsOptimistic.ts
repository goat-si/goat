import { ProjectId, type EnvironmentId, type ServerSettings } from "@goat/contracts";
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

function matchesSavedWrite(write: PendingScopedWrite, settings: ServerSettings): boolean {
  const saved = write.saved;
  if (saved === undefined) return false;
  const planned = write
    .plan(write.environments)
    .serverWrites.find((candidate) => candidate.environmentId === write.environmentId);
  if (planned === undefined) return Equal.equals(settings, saved);
  const patch = planned.patch;
  return Object.keys(patch).every((key) => {
    if (key === "projectSettingsOverrides" && patch.projectSettingsOverrides !== undefined) {
      return Object.entries(patch.projectSettingsOverrides).every(([projectId, entry]) => {
        const id = ProjectId.make(projectId);
        const previous = planned.previous.projectSettingsOverrides[id];
        const actual = settings.projectSettingsOverrides[id];
        const expected = saved.projectSettingsOverrides[id];
        if (entry === null) return Equal.equals(actual, expected);
        const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(entry)]);
        return [...keys].every((field) => {
          const property = field as keyof typeof entry;
          if (Equal.equals(previous?.[property], entry[property])) return true;
          return Equal.equals(actual?.[property], expected?.[property]);
        });
      });
    }
    if (!Object.hasOwn(saved, key)) return Equal.equals(settings, saved);
    const settingKey = key as keyof ServerSettings;
    return Equal.equals(settings[settingKey], saved[settingKey]);
  });
}

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
    if (current === undefined || write.saved === undefined) return true;
    const group = writes.filter(
      (candidate) =>
        candidate.environmentId === write.environmentId &&
        candidate.saved !== undefined &&
        Equal.equals(candidate.saved, write.saved),
    );
    return !group.every((candidate) => matchesSavedWrite(candidate, current));
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
        matchesSavedWrite(write, config.settings)
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
