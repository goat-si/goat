import {
  type ComputerUseElement,
  type ComputerUseObservation,
  type ComputerUseRefusal,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

/**
 * Turns Cua Driver window reads into helper-protocol observations (D4 in epic #1140).
 *
 * The driver names elements with tokens that die on its next snapshot of the window. GOAT keeps
 * its own refs, stable across reads of one lineage, by matching each element's position in the
 * tree (role, label and ordinal under its parent). A read that cannot be diffed safely, because
 * elements moved, the walk stopped early, the window changed size, or its epoch changed, starts a
 * new lineage with a full observation. Refs never outlive their lineage: acting on one is a
 * staleElement refusal, never a guess.
 */

/** The fields of a pinned 0.37.0 get_window_state structuredContent this module reads. */
const DriverElement = Schema.Struct({
  element_index: Schema.optionalKey(Schema.Number),
  element_token: Schema.optionalKey(Schema.String),
  role: Schema.String,
  label: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(Schema.Boolean),
  actions: Schema.optionalKey(Schema.Array(Schema.String)),
  parent_index: Schema.optionalKey(Schema.Number),
  screenshot_frame: Schema.optionalKey(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number }),
  ),
});
type DriverElement = typeof DriverElement.Type;

export const DriverWindowState = Schema.Struct({
  pid: Schema.Number,
  window_id: Schema.Number,
  elements: Schema.optionalKey(Schema.Array(DriverElement)),
  truncated: Schema.optionalKey(Schema.Boolean),
  degraded_reason: Schema.optionalKey(Schema.String),
  screenshot_mime_type: Schema.optionalKey(Schema.String),
  screenshot_width: Schema.optionalKey(Schema.Number),
  screenshot_height: Schema.optionalKey(Schema.Number),
  screenshot_scale: Schema.optionalKey(Schema.Number),
  window_bounds: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  on_current_space: Schema.optionalKey(Schema.Boolean),
});
export type DriverWindowState = typeof DriverWindowState.Type;

interface Tracked {
  readonly ref: string;
  readonly element: ComputerUseElement;
  readonly token: string | undefined;
}

interface Lineage {
  readonly id: string;
  readonly epoch: string;
  readonly size: string;
  readonly latest: string;
  readonly observations: ReadonlySet<string>;
  readonly complete: boolean;
  readonly elements: ReadonlyMap<string, Tracked>;
  readonly order: ReadonlyArray<string>;
  nextRef: number;
}

/**
 * The window's identity apart from its contents: the process, the window, its display scale and
 * whether it is on the current Space. Any change invalidates every ref.
 */
const epochOf = (read: DriverWindowState) =>
  [
    read.pid,
    read.window_id,
    read.screenshot_scale ?? "-",
    read.on_current_space === false ? "away" : "here",
  ].join(":");
const sizeOf = (read: DriverWindowState) =>
  read.window_bounds ? read.window_bounds.width + "x" + read.window_bounds.height : "-";

/** Tree position keys in document order, for the addressable elements of a read. */
function keyed(elements: ReadonlyArray<DriverElement>) {
  const byIndex = new Map<number, string>();
  const ordinals = new Map<string, number>();
  const result: Array<{ key: string; element: DriverElement }> = [];
  for (const element of elements) {
    if (element.element_index === undefined) continue;
    const parent =
      element.parent_index === undefined ? "" : (byIndex.get(element.parent_index) ?? "?");
    const base = parent + "/" + element.role + ":" + (element.label ?? "");
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    const key = base + "#" + ordinal;
    byIndex.set(element.element_index, key);
    result.push({ key, element });
  }
  return result;
}

const sameElement = (a: ComputerUseElement, b: ComputerUseElement) =>
  JSON.stringify({ ...a, parent: undefined }) === JSON.stringify({ ...b, parent: undefined });

export interface ObservationTracker {
  /**
   * Records one driver read of a window and returns what the agent sees. since is the agent's
   * last observation id; privateMode comes from the helper's own check of the focused element.
   */
  readonly observe: (input: {
    readonly read: DriverWindowState;
    readonly since?: string | undefined;
    readonly screenshot: boolean;
    readonly privateMode: boolean;
  }) => ComputerUseObservation;
  /** The driver token for an element ref the agent read in observationId, or why there is none. */
  readonly resolve: (input: {
    readonly pid: number;
    readonly windowId: number;
    readonly observationId: string;
    readonly element: string;
  }) => { readonly token: string } | ComputerUseRefusal;
  /** Whether pixel coordinates from observationId still describe the window's screenshot. */
  readonly pointsCurrent: (input: {
    readonly pid: number;
    readonly windowId: number;
    readonly observationId: string;
  }) => true | ComputerUseRefusal;
}

export function makeObservationTracker(newId: () => string): ObservationTracker {
  const lineages = new Map<string, Lineage & { keys: Map<string, string> }>();
  const targetKey = (pid: number, windowId: number) => pid + ":" + windowId;
  const stale = (message: string): ComputerUseRefusal => ({
    outcome: "refused",
    reason: "staleElement",
    message,
  });

  return {
    observe: ({ read, since, screenshot, privateMode }) => {
      const key = targetKey(read.pid, read.window_id);
      const previous = lineages.get(key);
      const entries = keyed(read.elements ?? []);
      const epoch = epochOf(read);
      const size = sizeOf(read);
      const complete = read.truncated !== true && read.degraded_reason === undefined;
      const observationId = newId();
      const toElement = (ref: string, element: DriverElement, parent: string | undefined) => {
        const frame = element.screenshot_frame;
        return {
          ref,
          role: element.role,
          ...(element.label === undefined ? {} : { label: element.label }),
          ...(element.value === undefined || privateMode ? {} : { value: element.value }),
          actions: [...(element.actions ?? [])],
          ...(frame ? { frame: { x: frame.x, y: frame.y, width: frame.w, height: frame.h } } : {}),
          ...(parent === undefined ? {} : { parent }),
        } satisfies ComputerUseElement;
      };
      const common = {
        observationId,
        target: { pid: read.pid, windowId: read.window_id, epoch },
        complete,
        privateMode,
        ...(screenshot &&
        !privateMode &&
        read.screenshot_width !== undefined &&
        read.screenshot_height !== undefined
          ? {
              screenshot: {
                mimeType: read.screenshot_mime_type ?? "image/png",
                width: read.screenshot_width,
                height: read.screenshot_height,
              },
            }
          : {}),
        ...(read.degraded_reason === undefined ? {} : { degraded: read.degraded_reason }),
      };

      const fullReason =
        previous === undefined
          ? since === undefined
            ? "first"
            : "unknown_since"
          : since === undefined || !previous.observations.has(since)
            ? "unknown_since"
            : previous.epoch !== epoch
              ? "epoch_changed"
              : previous.size !== size
                ? "window_changed"
                : !previous.complete
                  ? "incomplete"
                  : undefined;
      // Elements already seen must keep their relative order for a diff to be trustworthy.
      let last = -1;
      const reordered =
        previous !== undefined &&
        entries.some(({ key: k }) => {
          const ref = previous.keys.get(k);
          if (ref === undefined) return false;
          const position = previous.order.indexOf(ref);
          const moved = position < last;
          last = position;
          return moved;
        });
      const reason = fullReason ?? (reordered ? "reordered" : undefined);

      if (reason !== undefined || previous === undefined) {
        const lineage = newId();
        const keys = new Map<string, string>();
        const elements = new Map<string, Tracked>();
        const indexRefs = new Map<number, string>();
        let nextRef = 0;
        for (const { key: k, element } of entries) {
          const ref = lineage + ":" + ++nextRef;
          keys.set(k, ref);
          indexRefs.set(element.element_index ?? -1, ref);
          const parent =
            element.parent_index === undefined ? undefined : indexRefs.get(element.parent_index);
          elements.set(ref, {
            ref,
            token: element.element_token,
            element: toElement(ref, element, parent),
          });
        }
        lineages.set(key, {
          id: lineage,
          epoch,
          size,
          latest: observationId,
          observations: new Set([observationId]),
          complete,
          elements,
          order: [...elements.keys()],
          keys,
          nextRef,
        });
        return {
          ...common,
          lineage,
          kind: "full",
          reason: reason ?? "first",
          elements: [...elements.values()].map(({ element }) => element),
        };
      }

      const keys = new Map<string, string>();
      const elements = new Map<string, Tracked>();
      const indexRefs = new Map<number, string>();
      const added: ComputerUseElement[] = [];
      const changed: ComputerUseElement[] = [];
      for (const { key: k, element } of entries) {
        const existing = previous.keys.get(k);
        const ref = existing ?? previous.id + ":" + ++previous.nextRef;
        keys.set(k, ref);
        indexRefs.set(element.element_index ?? -1, ref);
        const parent =
          element.parent_index === undefined ? undefined : indexRefs.get(element.parent_index);
        const next = toElement(ref, element, parent);
        elements.set(ref, { ref, token: element.element_token, element: next });
        if (existing === undefined) added.push(next);
        else {
          const before = previous.elements.get(existing);
          if (before && !sameElement(before.element, next)) changed.push(next);
        }
      }
      const removed = previous.order.filter((ref) => !elements.has(ref));
      lineages.set(key, {
        ...previous,
        latest: observationId,
        observations: new Set([...previous.observations, observationId]),
        complete,
        elements,
        order: [...elements.keys()],
        keys,
      });
      return {
        ...common,
        lineage: previous.id,
        kind: "diff",
        since: since ?? previous.latest,
        added,
        changed,
        removed,
      };
    },

    resolve: ({ pid, windowId, observationId, element }) => {
      const lineage = lineages.get(targetKey(pid, windowId));
      if (!lineage || !lineage.observations.has(observationId))
        return stale("That observation is no longer current for this window. Observe it again.");
      const tracked = lineage.elements.get(element);
      if (!tracked?.token) return stale("That element is gone from the window. Observe it again.");
      return { token: tracked.token };
    },

    pointsCurrent: ({ pid, windowId, observationId }) => {
      const lineage = lineages.get(targetKey(pid, windowId));
      return lineage?.latest === observationId
        ? true
        : stale("Those coordinates are from an older screenshot. Observe the window again.");
    },
  };
}
