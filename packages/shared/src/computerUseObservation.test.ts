import { describe, expect, it } from "vite-plus/test";

import { makeObservationTracker, type DriverWindowState } from "./computerUseObservation.ts";

// Trimmed to the fields a pinned 0.37.0 get_window_state (tree_format "elements") returns.
const read = (
  snapshot: number,
  rows: ReadonlyArray<{ role: string; label?: string; value?: string; parent?: number }>,
  extra: Partial<DriverWindowState> = {},
): DriverWindowState => ({
  pid: 10,
  window_id: 20,
  truncated: false,
  screenshot_width: 800,
  screenshot_height: 600,
  screenshot_mime_type: "image/png",
  screenshot_scale: 2,
  window_bounds: { width: 400, height: 300 },
  elements: rows.map((row, index) => ({
    element_index: index,
    element_token: "s" + snapshot + ":" + index,
    role: row.role,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.value === undefined ? {} : { value: row.value }),
    ...(row.parent === undefined ? {} : { parent_index: row.parent }),
    actions: ["AXPress"],
  })),
  ...extra,
});

const form = [
  { role: "AXGroup", label: "Form" },
  { role: "AXTextField", label: "Name", value: "", parent: 0 },
  { role: "AXButton", label: "Save", parent: 0 },
];

const tracker = () => {
  let id = 0;
  return makeObservationTracker(() => "id" + ++id);
};
const target = { pid: 10, windowId: 20 };

describe("computer use observations", () => {
  it("keeps element refs across reads while the driver's tokens change, and diffs the changes", () => {
    const observations = tracker();
    const first = observations.observe({
      read: read(1, form),
      screenshot: true,
      privateMode: false,
    });
    expect(first).toMatchObject({ kind: "full", reason: "first", complete: true });
    if (first.kind !== "full") return;
    const save = first.elements.find((element) => element.label === "Save")!.ref;
    expect(
      observations.resolve({ ...target, observationId: first.observationId, element: save }),
    ).toEqual({ token: "s1:2" });

    const typed = [
      ...form.slice(0, 1),
      { ...form[1]!, value: "Ada" },
      form[2]!,
      { role: "AXButton", label: "Cancel", parent: 0 },
    ];
    const second = observations.observe({
      read: read(2, typed),
      since: first.observationId,
      screenshot: true,
      privateMode: false,
    });
    expect(second).toMatchObject({
      kind: "diff",
      since: first.observationId,
      lineage: first.lineage,
      removed: [],
    });
    if (second.kind !== "diff") return;
    expect(second.changed.map((element) => [element.label, element.value])).toEqual([
      ["Name", "Ada"],
    ]);
    expect(second.added.map((element) => element.label)).toEqual(["Cancel"]);
    // The same ref now reaches the driver's newer token.
    expect(
      observations.resolve({ ...target, observationId: second.observationId, element: save }),
    ).toEqual({ token: "s2:2" });

    const third = observations.observe({
      read: read(3, form),
      since: second.observationId,
      screenshot: false,
      privateMode: false,
    });
    expect(third).toMatchObject({ kind: "diff", removed: [second.added[0]!.ref] });
    expect(
      observations.resolve({
        ...target,
        observationId: third.observationId,
        element: second.added[0]!.ref,
      }),
    ).toMatchObject({ reason: "staleElement" });
  });

  it.each([
    {
      name: "elements moved",
      next: read(2, [
        { role: "AXGroup", label: "Form" },
        { role: "AXButton", label: "Save", parent: 0 },
        { role: "AXTextField", label: "Name", value: "", parent: 0 },
      ]),
      reason: "reordered",
    },
    {
      name: "the window was resized",
      next: read(2, form, { window_bounds: { width: 500, height: 300 } }),
      reason: "window_changed",
    },
    {
      name: "the window moved to another Space",
      next: read(2, form, { on_current_space: false }),
      reason: "epoch_changed",
    },
    {
      name: "it moved to a display with another scale",
      next: read(2, form, { screenshot_scale: 1 }),
      reason: "epoch_changed",
    },
  ])("starts a new lineage when $name, and refs from the old one are stale", ({ next, reason }) => {
    const observations = tracker();
    const first = observations.observe({
      read: read(1, form),
      screenshot: true,
      privateMode: false,
    });
    if (first.kind !== "full") throw new Error("expected a full observation");
    const second = observations.observe({
      read: next,
      since: first.observationId,
      screenshot: true,
      privateMode: false,
    });
    expect(second).toMatchObject({ kind: "full", reason });
    expect(second.lineage).not.toBe(first.lineage);
    expect(
      observations.resolve({
        ...target,
        observationId: first.observationId,
        element: first.elements[2]!.ref,
      }),
    ).toMatchObject({ reason: "staleElement" });
  });

  it("reads in full after a truncated walk or from an unknown observation", () => {
    const observations = tracker();
    const cut = observations.observe({
      read: read(1, form, { truncated: true }),
      screenshot: true,
      privateMode: false,
    });
    expect(cut.complete).toBe(false);
    const after = observations.observe({
      read: read(2, form),
      since: cut.observationId,
      screenshot: true,
      privateMode: false,
    });
    expect(after).toMatchObject({ kind: "full", reason: "incomplete" });
    expect(
      observations.observe({
        read: read(3, form),
        since: "elsewhere",
        screenshot: true,
        privateMode: false,
      }),
    ).toMatchObject({ kind: "full", reason: "unknown_since" });
  });

  it("accepts pixel points only from the latest screenshot", () => {
    const observations = tracker();
    const first = observations.observe({
      read: read(1, form),
      screenshot: true,
      privateMode: false,
    });
    expect(observations.pointsCurrent({ ...target, observationId: first.observationId })).toBe(
      true,
    );
    const second = observations.observe({
      read: read(2, form),
      since: first.observationId,
      screenshot: true,
      privateMode: false,
    });
    expect(
      observations.pointsCurrent({ ...target, observationId: first.observationId }),
    ).toMatchObject({ reason: "staleElement" });
    expect(observations.pointsCurrent({ ...target, observationId: second.observationId })).toBe(
      true,
    );
  });

  it("withholds values and the screenshot while a secure field has focus", () => {
    const observations = tracker();
    const secret = observations.observe({
      read: read(1, [{ role: "AXTextField", label: "Password", value: "hunter2" }]),
      screenshot: true,
      privateMode: true,
    });
    expect(secret.privateMode).toBe(true);
    expect(secret.screenshot).toBeUndefined();
    expect(JSON.stringify(secret)).not.toContain("hunter2");
  });
});
