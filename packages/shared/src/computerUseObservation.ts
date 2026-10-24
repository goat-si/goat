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
 * its own refs across reads of one lineage, keyed by tree position: role and label under the
 * parent's key. A ref carries over only when that position is unambiguous all the way up; a
 * group of siblings with the same role and label, anything under one, and anything whose parent
 * the read does not name get new refs on every read. A read that cannot be diffed safely starts
 * a new lineage with a full observation, and refs never outlive their lineage: acting on one is
 * a staleElement refusal, never a guess.
 */

/** The fields of a pinned 0.37.0 get_window_state structuredContent this module reads. */
const DriverElement = Schema.Struct({
  element_index: Schema.optionalKey(Schema.Number),
  element_token: Schema.optionalKey(Schema.String),
  role: Schema.String,
  label: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  actions: Schema.optionalKey(Schema.Array(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
  selected: Schema.optionalKey(Schema.Boolean),
  // Not sent by the driver: a platform layer sets them where it knows better (computerUseWindows).
  checked: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("mixed")])),
  expanded: Schema.optionalKey(Schema.Boolean),
  parent_index: Schema.optionalKey(Schema.Number),
  /** Screen pixels; platform layers use it to join their own reads to the driver's. */
  frame: Schema.optionalKey(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number }),
  ),
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
  window_bounds: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
});
export type DriverWindowState = typeof DriverWindowState.Type;

/** Windows tracked at once, private ones included; the least recently observed goes first. */
const MAX_WINDOWS = 32;

interface Tracked {
  readonly element: ComputerUseElement;
  readonly token: string | undefined;
}

interface Lineage {
  readonly id: string;
  readonly epoch: string;
  readonly scope: string;
  readonly size: string;
  readonly latest: string;
  /** Pixel points need the latest observation to have shown a screenshot. */
  readonly latestHasScreenshot: boolean;
  readonly complete: boolean;
  /** Matchable position key → ref. */
  readonly keys: ReadonlyMap<string, string>;
  readonly elements: ReadonlyMap<string, Tracked>;
  readonly order: ReadonlyArray<string>;
  readonly nextRef: number;
}

const sizeOf = (read: DriverWindowState) =>
  read.window_bounds ? read.window_bounds.width + "x" + read.window_bounds.height : "-";

/**
 * Position keys in document order. matchable is false when the position does not identify one
 * element: duplicate siblings, a descendant of one, or a parent the read does not name.
 */
function positions(elements: ReadonlyArray<DriverElement>) {
  const addressable = elements.filter((element) => element.element_index !== undefined);
  const byIndex = new Map<number, { key: string; matchable: boolean }>();
  // Each step is a JSON pair, which escapes quotes and brackets, so no label can make one path
  // read as another.
  const base = (element: DriverElement, parentKey: string) =>
    parentKey + JSON.stringify([element.role, element.label ?? null]);
  // First pass: how many siblings share each base, with parents resolved in document order.
  const counts = new Map<string, number>();
  const draft = new Map<number, string>();
  for (const element of addressable) {
    const parent = element.parent_index === undefined ? "" : draft.get(element.parent_index);
    const key = parent === undefined ? "?" : base(element, parent);
    draft.set(element.element_index ?? -1, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return addressable.map((element) => {
    const parent =
      element.parent_index === undefined
        ? { key: "", matchable: true }
        : byIndex.get(element.parent_index);
    const key = parent ? base(element, parent.key) : "?";
    const matchable = parent !== undefined && parent.matchable && (counts.get(key) ?? 0) === 1;
    byIndex.set(element.element_index ?? -1, { key, matchable });
    return { key, matchable, element };
  });
}

export interface ObservationTracker {
  /**
   * Records one driver read of a window. since is the agent's last observation id. epoch comes
   * from the helper and names the window's incarnation, Space and display. scope names the
   * read's query and limits. privateMode comes from the helper's own focused-element check.
   */
  readonly observe: (input: {
    readonly read: DriverWindowState;
    readonly since?: string | undefined;
    readonly epoch: string;
    readonly scope: string;
    readonly screenshot: boolean;
    readonly privateMode: boolean;
  }) => ComputerUseObservation;
  /**
   * The driver token for an element ref the agent read in observationId, with the element's
   * frame in screenshot pixels when it has one, or why there is none.
   */
  readonly resolve: (input: {
    readonly pid: number;
    readonly windowId: number;
    readonly observationId: string;
    readonly element: string;
  }) =>
    | { readonly token: string; readonly frame?: ComputerUseElement["frame"] }
    | ComputerUseRefusal;
  /** Whether pixel coordinates from observationId still describe the window's screenshot. */
  readonly pointsCurrent: (input: {
    readonly pid: number;
    readonly windowId: number;
    readonly observationId: string;
  }) => true | ComputerUseRefusal;
  /** Drops everything known about a window, such as when it closes or the session ends. */
  readonly forget: (pid: number, windowId: number) => void;
  /**
   * Whether an action may still be sent for observationId: it is the window's latest
   * observation, under the same epoch, and no secure field has focus. Every action passes this,
   * keyboard input included, before anything reaches the driver.
   */
  readonly confirm: (input: {
    readonly pid: number;
    readonly windowId: number;
    readonly observationId: string;
    readonly epoch: string;
  }) => true | ComputerUseRefusal;
}

export function makeObservationTracker(newId: () => string): ObservationTracker {
  /** A window's lineage, or "private" while a secure field has focus in it. */
  const windows = new Map<string, Lineage | "private">();
  const targetKey = (pid: number, windowId: number) => pid + ":" + windowId;
  const refuse = (
    reason: "staleElement" | "privateMode" | "epochChanged",
    message: string,
  ): ComputerUseRefusal => ({
    outcome: "refused",
    reason,
    message,
  });
  const remember = (key: string, entry: Lineage | "private") => {
    windows.delete(key);
    windows.set(key, entry);
    for (const oldest of windows.keys()) {
      if (windows.size <= MAX_WINDOWS) break;
      windows.delete(oldest);
    }
  };
  const current = (pid: number, windowId: number, observationId: string) => {
    const key = targetKey(pid, windowId);
    const lineage = windows.get(key);
    if (lineage === "private")
      return refuse("privateMode", "A password field has focus. Wait for the person to leave it.");
    return lineage?.latest === observationId
      ? lineage
      : refuse(
          "staleElement",
          "That observation is no longer the latest for this window. Observe it again.",
        );
  };

  return {
    observe: ({ read, since, epoch, scope, screenshot, privateMode }) => {
      const key = targetKey(read.pid, read.window_id);
      const observationId = newId();
      const target = { pid: read.pid, windowId: read.window_id, epoch };
      if (privateMode) {
        // Nothing of the window leaves while a secure field has focus (D6), not even labels,
        // which the driver can derive from a field's value.
        remember(key, "private");
        return {
          observationId,
          lineage: observationId,
          target,
          complete: false,
          privateMode: true,
          kind: "full",
          reason: "incomplete",
          elements: [],
        };
      }
      const stored = windows.get(key);
      const previous = stored === "private" ? undefined : stored;
      const entries = positions(read.elements ?? []);
      const size = sizeOf(read);
      const complete = read.truncated !== true && read.degraded_reason === undefined;
      const hasScreenshot =
        screenshot && read.screenshot_width !== undefined && read.screenshot_height !== undefined;
      const common = {
        observationId,
        target,
        complete,
        privateMode: false,
        ...(hasScreenshot
          ? {
              screenshot: {
                mimeType: read.screenshot_mime_type ?? "image/png",
                width: read.screenshot_width ?? 0,
                height: read.screenshot_height ?? 0,
              },
            }
          : {}),
        ...(read.degraded_reason === undefined ? {} : { degraded: read.degraded_reason }),
      };
      const toElement = (ref: string, element: DriverElement, parent: string | undefined) => {
        const frame = element.screenshot_frame;
        return {
          ref,
          role: element.role,
          ...(element.label === undefined ? {} : { label: element.label }),
          ...(element.value === undefined ? {} : { value: element.value }),
          actions: [...(element.actions ?? [])],
          ...(element.enabled === undefined &&
          element.selected === undefined &&
          element.checked === undefined &&
          element.expanded === undefined
            ? {}
            : {
                state: {
                  ...(element.enabled === undefined ? {} : { enabled: element.enabled }),
                  ...(element.selected === undefined ? {} : { selected: element.selected }),
                  ...(element.checked === undefined ? {} : { checked: element.checked }),
                  ...(element.expanded === undefined ? {} : { expanded: element.expanded }),
                },
              }),
          ...(frame ? { frame: { x: frame.x, y: frame.y, width: frame.w, height: frame.h } } : {}),
          ...(parent === undefined ? {} : { parent }),
        } satisfies ComputerUseElement;
      };

      // A diff is only trusted against the exact state the agent last saw, read the same way.
      const fullReason =
        previous === undefined
          ? since === undefined
            ? "first"
            : "unknown_since"
          : since !== previous.latest
            ? "unknown_since"
            : previous.epoch !== epoch
              ? "epoch_changed"
              : previous.scope !== scope
                ? "scope_changed"
                : previous.size !== size
                  ? "window_changed"
                  : !previous.complete || !complete
                    ? "incomplete"
                    : undefined;
      let last = -1;
      const reordered =
        previous !== undefined &&
        entries.some(({ key: k, matchable }) => {
          const ref = matchable ? previous.keys.get(k) : undefined;
          if (ref === undefined) return false;
          const position = previous.order.indexOf(ref);
          const moved = position < last;
          last = position;
          return moved;
        });
      const reason = fullReason ?? (reordered ? "reordered" : undefined);
      const diffing = reason === undefined && previous !== undefined ? previous : undefined;

      const lineageId = diffing?.id ?? newId();
      let nextRef = diffing?.nextRef ?? 0;
      const keys = new Map<string, string>();
      const elements = new Map<string, Tracked>();
      const indexRefs = new Map<number, string>();
      const added: ComputerUseElement[] = [];
      const changed: ComputerUseElement[] = [];
      for (const { key: k, matchable, element } of entries) {
        const existing = matchable ? diffing?.keys.get(k) : undefined;
        const ref = existing ?? lineageId + ":" + ++nextRef;
        if (matchable) keys.set(k, ref);
        indexRefs.set(element.element_index ?? -1, ref);
        const parent =
          element.parent_index === undefined ? undefined : indexRefs.get(element.parent_index);
        const next = toElement(ref, element, parent);
        elements.set(ref, { token: element.element_token, element: next });
        if (existing === undefined) added.push(next);
        else {
          const before = diffing?.elements.get(existing)?.element;
          if (before && JSON.stringify(before) !== JSON.stringify(next)) changed.push(next);
        }
      }
      remember(key, {
        id: lineageId,
        epoch,
        scope,
        size,
        latest: observationId,
        latestHasScreenshot: hasScreenshot,
        complete,
        keys,
        elements,
        order: [...elements.keys()],
        nextRef,
      });
      if (!diffing)
        return {
          ...common,
          lineage: lineageId,
          kind: "full",
          reason: reason ?? "first",
          elements: [...elements.values()].map(({ element }) => element),
        };
      return {
        ...common,
        lineage: lineageId,
        kind: "diff",
        since: diffing.latest,
        added,
        changed,
        removed: diffing.order.filter((ref) => !elements.has(ref)),
      };
    },

    resolve: ({ pid, windowId, observationId, element }) => {
      const lineage = current(pid, windowId, observationId);
      if ("outcome" in lineage) return lineage;
      const tracked = lineage.elements.get(element);
      if (!tracked?.token)
        return refuse(
          "staleElement",
          "That element is not in the latest observation. Observe it again.",
        );
      const frame = tracked.element.frame;
      return frame ? { token: tracked.token, frame } : { token: tracked.token };
    },

    pointsCurrent: ({ pid, windowId, observationId }) => {
      const lineage = current(pid, windowId, observationId);
      if ("outcome" in lineage) return lineage;
      return lineage.latestHasScreenshot
        ? true
        : refuse(
            "staleElement",
            "That observation had no screenshot to point into. Observe it with one.",
          );
    },

    forget: (pid, windowId) => {
      windows.delete(targetKey(pid, windowId));
    },

    confirm: ({ pid, windowId, observationId, epoch }) => {
      const lineage = current(pid, windowId, observationId);
      if ("outcome" in lineage) return lineage;
      return lineage.epoch === epoch
        ? true
        : refuse(
            "epochChanged",
            "The window moved or changed since that observation. Observe it again.",
          );
    },
  };
}
