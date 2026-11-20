import { useGT, useLocale } from "gt-react";
import { useSnoozePresetLabel } from "./useSnoozePresetLabel";
import type { EnvironmentId } from "@goat/contracts";
import type { TimestampFormat } from "@goat/contracts/settings";
import {
  pickSnoozePreset as pickSharedSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@goat/client-runtime/state/thread-settled";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { toastManager } from "./ui/toast";

export { snoozeWakeLabel, type SnoozePreset };

/** Both sidebar entry points use the same formatted presets and context menu labels. */
export function useSidebarSnooze(timestampFormat: TimestampFormat) {
  const gt = useGT();
  const locale = useLocale();
  const formatLabel = useSnoozePresetLabel();

  return {
    triggerLabel: gt("Snooze thread"),
    snoozeLabels: {
      snooze: gt("Snooze"),
      wake: gt("Wake thread"),
      custom: gt("Custom…"),
    },
    bulkSnoozeLabel: (count: number) => gt("Snooze ({count})", { count }),
    /** The environment's presets are read when the menu opens. */
    resolveSnoozePresets: (now: Date, environmentId: EnvironmentId) =>
      resolveSharedSnoozePresets(now, {
        ...snoozeOptions(timestampFormat, environmentId),
        locale,
        formatLabel,
      }),
    pickSnoozePreset: (
      shown: ReadonlyArray<SnoozePreset>,
      id: string,
      environmentId: EnvironmentId,
    ) => {
      const picked = pickSharedSnoozePreset({
        shown,
        id,
        now: new Date(),
        ...snoozeOptions(timestampFormat, environmentId),
      });
      if (!picked) {
        toastManager.add({
          type: "warning",
          title: gt("Could not snooze thread"),
          description: gt("That snooze time has passed. Choose another time."),
        });
      }
      return picked;
    },
  };
}

function snoozeOptions(timestampFormat: TimestampFormat, environmentId: EnvironmentId) {
  const presets = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.snoozePresets;
  return {
    ...(presets ? { presets } : {}),
    formatTime: (date: Date) => formatShortTimestamp(date.toISOString(), timestampFormat),
  };
}
