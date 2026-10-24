import type { ComputerUseObservation } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeObservationTracker, type DriverWindowState } from "./computerUseObservation.ts";

type Row = { role: string; label?: string; value?: string; parent?: number };

// Trimmed to the fields a pinned 0.37.0 get_window_state (tree_format "elements") returns.
const read = (
  snapshot: number,
  rows: ReadonlyArray<Row>,
  extra: Partial<DriverWindowState> = {},
): DriverWindowState => ({
  pid: 10,
  window_id: 20,
  truncated: false,
  screenshot_width: 800,
  screenshot_height: 600,
  screenshot_mime_type: "image/png",
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

const form: ReadonlyArray<Row> = [
  { role: "AXGroup", label: "Form" },
  { role: "AXTextField", label: "Name", value: "", parent: 0 },
  { role: "AXButton", label: "Save", parent: 0 },
];

const setup = () => {
  let id = 0;
  const tracker = makeObservationTracker(() => "id" + ++id);
  const observe = (
    r: DriverWindowState,
    since?: string,
    options: { epoch?: string; scope?: string; screenshot?: boolean; privateMode?: boolean } = {},
  ) =>
    tracker.observe({
      read: r,
      since,
      epoch: options.epoch ?? "window-1@space-1@display-1",
      scope: options.scope ?? "all",
      screenshot: options.screenshot ?? true,
      privateMode: options.privateMode ?? false,
    });
  return { tracker, observe };
};
const target = { pid: 10, windowId: 20 };
const refOf = (observation: ComputerUseObservation, label: string) =>
  observation.kind === "full"
    ? (observation.elements.find((element) => element.label === label)?.ref ?? "")
    : "";

describe("computer use observations", () => {
  it("keeps element refs across reads while the driver's tokens change, and diffs the changes", () => {
    const { tracker, observe } = setup();
    const first = observe(read(1, form));
    expect(first).toMatchObject({ kind: "full", reason: "first", complete: true });
    const save = refOf(first, "Save");
    expect(
      tracker.resolve({ ...target, observationId: first.observationId, element: save }),
    ).toEqual({ token: "s1:2" });

    const typed = [
      form[0]!,
      { ...form[1]!, value: "Ada" },
      form[2]!,
      { role: "AXButton", label: "Cancel", parent: 0 },
    ];
    const second = observe(read(2, typed), first.observationId);
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
    expect(
      tracker.resolve({ ...target, observationId: second.observationId, element: save }),
    ).toEqual({ token: "s2:2" });
    // Only the latest observation resolves.
    expect(
      tracker.resolve({ ...target, observationId: first.observationId, element: save }),
    ).toMatchObject({ reason: "staleElement" });
  });

  it("never hands one of two identical siblings the other's ref", () => {
    const { tracker, observe } = setup();
    const rows: Row[] = [
      { role: "AXList", label: "Files" },
      { role: "AXButton", label: "Delete", parent: 0 },
      { role: "AXButton", label: "Delete", parent: 0 },
    ];
    const first = observe(read(1, rows));
    if (first.kind !== "full") throw new Error("expected full");
    const [, firstDelete, secondDelete] = first.elements.map((element) => element.ref);
    // The first Delete went away; the remaining one must not inherit its ref.
    const second = observe(read(2, rows.slice(0, 2)), first.observationId);
    if (second.kind !== "diff") throw new Error("expected diff");
    expect(second.removed).toEqual([firstDelete, secondDelete]);
    expect(second.added.map((element) => element.ref)).not.toContain(firstDelete);
    expect(
      tracker.resolve({ ...target, observationId: second.observationId, element: firstDelete! }),
    ).toMatchObject({ reason: "staleElement" });
  });

  it("gives an element under an unnamed parent no lasting ref", () => {
    const { observe } = setup();
    const orphan: Row[] = [
      { role: "AXGroup", label: "Form" },
      { role: "AXButton", label: "Save", parent: 7 },
    ];
    const first = observe(read(1, orphan));
    const second = observe(read(2, orphan), first.observationId);
    expect(second).toMatchObject({ kind: "diff", removed: [refOf(first, "Save")] });
  });

  it.each([
    {
      name: "elements moved",
      next: () => read(2, [form[0]!, form[2]!, form[1]!]),
      options: {},
      reason: "reordered",
    },
    {
      name: "the window was resized",
      next: () => read(2, form, { window_bounds: { width: 500, height: 300 } }),
      options: {},
      reason: "window_changed",
    },
    {
      name: "the helper reports a new epoch",
      next: () => read(2, form),
      options: { epoch: "window-1@space-2@display-1" },
      reason: "epoch_changed",
    },
    {
      name: "the read used another query",
      next: () => read(2, form),
      options: { scope: "query=Save" },
      reason: "scope_changed",
    },
    {
      name: "this read was truncated",
      next: () => read(2, form, { truncated: true }),
      options: {},
      reason: "incomplete",
    },
  ])(
    "starts a new lineage when $name, and refs from the old one are stale",
    ({ next, options, reason }) => {
      const { tracker, observe } = setup();
      const first = observe(read(1, form));
      const second = observe(next(), first.observationId, options);
      expect(second).toMatchObject({ kind: "full", reason });
      expect(second.lineage).not.toBe(first.lineage);
      expect(
        tracker.resolve({
          ...target,
          observationId: second.observationId,
          element: refOf(first, "Save"),
        }),
      ).toMatchObject({ reason: "staleElement" });
    },
  );

  it("diffs only against the latest observation, never an older one", () => {
    const { observe } = setup();
    const first = observe(read(1, [form[0]!, { ...form[1]!, value: "0" }, form[2]!]));
    const second = observe(
      read(2, [form[0]!, { ...form[1]!, value: "1" }, form[2]!]),
      first.observationId,
    );
    expect(second.kind).toBe("diff");
    // Unchanged since second, but changed since first: a diff "since first" would be wrong.
    expect(
      observe(read(3, [form[0]!, { ...form[1]!, value: "1" }, form[2]!]), first.observationId),
    ).toMatchObject({ kind: "full", reason: "unknown_since" });
  });

  it("reads in full after a truncated walk", () => {
    const { observe } = setup();
    const cut = observe(read(1, form, { truncated: true }));
    expect(cut.complete).toBe(false);
    expect(observe(read(2, form), cut.observationId)).toMatchObject({
      kind: "full",
      reason: "incomplete",
    });
  });

  it("accepts pixel points only from the latest observation that showed a screenshot", () => {
    const { tracker, observe } = setup();
    const first = observe(read(1, form));
    expect(tracker.pointsCurrent({ ...target, observationId: first.observationId })).toBe(true);
    const second = observe(read(2, form), first.observationId, { screenshot: false });
    expect(tracker.pointsCurrent({ ...target, observationId: first.observationId })).toMatchObject({
      reason: "staleElement",
    });
    expect(tracker.pointsCurrent({ ...target, observationId: second.observationId })).toMatchObject(
      { reason: "staleElement" },
    );
  });

  it("shows nothing of the window while a secure field has focus, and refuses to act", () => {
    const { tracker, observe } = setup();
    const before = observe(read(1, form));
    const secret = observe(
      read(2, [{ role: "AXTextField", label: "hunter2" }]),
      before.observationId,
      { privateMode: true },
    );
    expect(secret).toMatchObject({
      privateMode: true,
      complete: false,
      kind: "full",
      elements: [],
    });
    expect(secret.screenshot).toBeUndefined();
    expect(JSON.stringify(secret)).not.toContain("hunter2");
    expect(
      tracker.resolve({
        ...target,
        observationId: secret.observationId,
        element: refOf(before, "Save"),
      }),
    ).toMatchObject({ reason: "privateMode" });
    expect(tracker.pointsCurrent({ ...target, observationId: secret.observationId })).toMatchObject(
      { reason: "privateMode" },
    );
    // After the field loses focus the window is read afresh.
    expect(observe(read(3, form), secret.observationId)).toMatchObject({
      kind: "full",
      privateMode: false,
    });
  });

  it("forgets windows on request and keeps at most 32", () => {
    const { tracker, observe } = setup();
    const first = observe(read(1, form));
    tracker.forget(10, 20);
    expect(tracker.pointsCurrent({ ...target, observationId: first.observationId })).toMatchObject({
      reason: "staleElement",
    });
    const oldest = observe(read(1, form, { window_id: 100 }));
    for (let window = 101; window <= 132; window++) observe(read(1, form, { window_id: window }));
    expect(
      tracker.pointsCurrent({ pid: 10, windowId: 100, observationId: oldest.observationId }),
    ).toMatchObject({ reason: "staleElement" });
  });
});

describe("computer use observation bookkeeping", () => {
  it.each(["Form/AXButton:Save", 'Form"]["AXButton","Save'])(
    "keeps a label that spells another path (%s) from taking that path's ref",
    (spelled) => {
      const { tracker, observe } = setup();
      const first = observe(
        read(1, [
          { role: "AXGroup", label: "Form" },
          { role: "AXButton", label: "Save", parent: 0 },
        ]),
      );
      const save = refOf(first, "Save");
      // The window now holds one group whose label reads like the old path to Save.
      const second = observe(read(2, [{ role: "AXGroup", label: spelled }]), first.observationId);
      expect(
        tracker.resolve({ ...target, observationId: second.observationId, element: save }),
      ).toMatchObject({ reason: "staleElement" });
    },
  );

  it("counts private windows toward the same 32-window limit", () => {
    const { tracker, observe } = setup();
    const secret = observe(read(1, form, { window_id: 100 }), undefined, { privateMode: true });
    for (let window = 101; window <= 132; window++)
      observe(read(1, form, { window_id: window }), undefined, { privateMode: true });
    // Forgotten, so the window reads as unknown rather than staying private forever.
    expect(
      tracker.pointsCurrent({ pid: 10, windowId: 100, observationId: secret.observationId }),
    ).toMatchObject({ reason: "staleElement" });
    expect(tracker.pointsCurrent({ pid: 10, windowId: 132, observationId: "any" })).toMatchObject({
      reason: "privateMode",
    });
  });
});

describe("computer use element state", () => {
  it("shows a toggled check box and a disabled button in the diff", () => {
    const { observe } = setup();
    const withState = (
      snapshot: number,
      agreed: boolean,
      saveEnabled: boolean,
    ): DriverWindowState => ({
      ...read(snapshot, [
        { role: "AXGroup", label: "Form" },
        { role: "AXCheckBox", label: "Agree", parent: 0 },
        { role: "AXButton", label: "Save", parent: 0 },
      ]),
      elements: [
        { element_index: 0, element_token: "s" + snapshot + ":0", role: "AXGroup", label: "Form" },
        {
          element_index: 1,
          element_token: "s" + snapshot + ":1",
          role: "AXCheckBox",
          label: "Agree",
          parent_index: 0,
          selected: agreed,
        },
        {
          element_index: 2,
          element_token: "s" + snapshot + ":2",
          role: "AXButton",
          label: "Save",
          parent_index: 0,
          enabled: saveEnabled,
        },
      ],
    });
    const first = observe(withState(1, false, false));
    if (first.kind !== "full") throw new Error("expected full");
    expect(first.elements.map((element) => element.state)).toEqual([
      undefined,
      { selected: false },
      { enabled: false },
    ]);
    const second = observe(withState(2, true, true), first.observationId);
    if (second.kind !== "diff") throw new Error("expected diff");
    expect(second.changed.map((element) => [element.label, element.state])).toEqual([
      ["Agree", { selected: true }],
      ["Save", { enabled: true }],
    ]);
  });
});
