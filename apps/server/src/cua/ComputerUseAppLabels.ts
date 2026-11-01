/**
 * The app each pid runs as the driver's answers name it, for the timeline row of a call that
 * names only a pid. Display only: a label never decides what a call may reach, which is why it
 * may come from any answer, list_windows included, where ComputerUseScope trusts only list_apps.
 *
 * @module ComputerUseAppLabels
 */
import type { ComputerUseCallAppLabel } from "@goat/contracts";

import { targetPid } from "./ComputerUseScope.ts";

/** A proxy outlives many apps; the oldest labels go first. */
const MAX_LABELS = 256;

interface NamedPid {
  readonly pid: number;
  readonly name: string | undefined;
  readonly bundleId?: string;
}

const bounded = (value: string | undefined, max: number) =>
  value !== undefined && value.length <= max ? value : undefined;

export const makeAppLabels = () => {
  const byPid = new Map<number, ComputerUseCallAppLabel>();
  return {
    learn: (entries: Iterable<NamedPid>) => {
      for (const entry of entries) {
        const name = bounded(entry.name, 160);
        const bundleId = bounded(entry.bundleId, 255);
        if (name === undefined && bundleId === undefined) continue;
        const known = byPid.get(entry.pid);
        // list_windows can name an app without its bundle id; keep the one list_apps gave.
        const kept =
          bundleId === undefined && known?.name?.toLowerCase() === name?.toLowerCase()
            ? known?.bundleId
            : bundleId;
        byPid.delete(entry.pid);
        byPid.set(entry.pid, {
          ...(kept === undefined ? {} : { bundleId: kept }),
          ...(name === undefined ? {} : { name }),
        });
        const oldest = byPid.keys().next();
        if (byPid.size > MAX_LABELS && oldest.done !== true) byPid.delete(oldest.value);
      }
    },
    /** The label of the pid a call's arguments name, when an answer named that pid. */
    forCall: (args: unknown) => {
      const pid = targetPid(
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Readonly<Record<string, unknown>>)
          : undefined,
      );
      return pid === undefined ? undefined : byPid.get(pid);
    },
  };
};

export type AppLabels = ReturnType<typeof makeAppLabels>;
