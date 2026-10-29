import type { SnoozePresetSetting } from "@goat/contracts";
import { resolveSnoozePreset, snoozePresetId } from "@goat/client-runtime/state/thread-settled";
import * as Equal from "effect/Equal";

/**
 * Whether two lists offer the same options. Order is only display order (menus sort by wake
 * time), so the row's Reset and the full-page Restore both compare this way.
 */
export function sameSnoozePresets(
  left: ReadonlyArray<SnoozePresetSetting>,
  right: ReadonlyArray<SnoozePresetSetting>,
): boolean {
  const ids = (presets: ReadonlyArray<SnoozePresetSetting>) =>
    presets.map(snoozePresetId).toSorted();
  return Equal.equals(ids(left), ids(right));
}

/**
 * Reads a server value against the editor's writes still in flight. Matching one acknowledges
 * it and every earlier write; anything else came from elsewhere and replaces the draft.
 */
export function reconcileSnoozeDraft<T>(
  pending: ReadonlyArray<T>,
  saved: T,
): { readonly adopt: true } | { readonly adopt: false; readonly pending: ReadonlyArray<T> } {
  const acknowledged = pending.findIndex((snapshot) => Equal.equals(snapshot, saved));
  return acknowledged === -1
    ? { adopt: true }
    : { adopt: false, pending: pending.slice(acknowledged + 1) };
}

/**
 * Orders editor rows the way the menu lists them: soonest wake first, with options that
 * have no wake right now (a passed "Today") last. Ties keep their current order.
 */
export function sortSnoozeRows<K>(
  presets: ReadonlyArray<SnoozePresetSetting>,
  keys: ReadonlyArray<K>,
  now: Date,
): { readonly presets: ReadonlyArray<SnoozePresetSetting>; readonly keys: ReadonlyArray<K> } {
  const order = presets
    .flatMap((preset, index) => {
      const key = keys[index];
      return key === undefined
        ? []
        : [{ preset, key, wake: resolveSnoozePreset(preset, now)?.snoozedUntil ?? null }];
    })
    .toSorted((a, b) =>
      a.wake === b.wake ? 0 : a.wake === null ? 1 : b.wake === null ? -1 : a.wake < b.wake ? -1 : 1,
    );
  return { presets: order.map(({ preset }) => preset), keys: order.map(({ key }) => key) };
}
