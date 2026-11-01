import { computerUseReady } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";

import { makeObservationTracker, type DriverWindowState } from "./computerUseObservation.ts";
import {
  windowsDriverRead,
  windowsComputerUseReadiness,
  windowsObservationTarget,
  type WindowsHelperReadiness,
  type WindowsWindowFacts,
} from "./computerUseWindows.ts";

// Recorded on mini (Windows 11 26200) from Cua Driver 0.37.0 under GOAT Computer Use.exe,
// reading scripts/computer-use-windows-fixture.cs; screenshots and unread fields trimmed.
const PID = 27088;
const WINDOW = 33685562;
const element = (
  index: number,
  role: string,
  label: string,
  actions: ReadonlyArray<string>,
  extra: { value?: string; selected?: boolean; parent?: number } = {},
) => ({
  element_index: index,
  element_token: "s00000001:" + index,
  role,
  label,
  actions: [...actions],
  ...(extra.value === undefined ? {} : { value: extra.value }),
  ...(extra.selected === undefined ? {} : { selected: extra.selected }),
  ...(extra.parent === undefined ? {} : { parent_index: extra.parent }),
});
const fixtureRead = (snapshot: string, note?: string, agree?: boolean): DriverWindowState => ({
  pid: PID,
  window_id: WINDOW,
  truncated: false,
  screenshot_mime_type: "image/png",
  screenshot_width: 420,
  screenshot_height: 260,
  window_bounds: { width: 422, height: 262 },
  elements: [
    element(0, "Edit", "Note", ["set_value"], note === undefined ? {} : { value: note }),
    // The driver reports the box's ToggleState as selected, false included.
    element(1, "CheckBox", "Agree", ["invoke", "toggle"], { selected: agree === true }),
    element(2, "Button", "Add one", ["invoke"]),
    element(3, "Button", "Focus secret", ["invoke"]),
    element(4, "Edit", "Secret", ["set_value"]),
    element(5, "TitleBar", "GOAT computer use fixture", ["set_value"], {
      value: "GOAT computer use fixture",
    }),
    element(6, "MenuItem", "시스템", ["invoke", "expand"], { parent: 5 }),
    element(9, "Button", "닫기", ["invoke"], { parent: 5 }),
  ].map((entry) => ({ ...entry, element_token: snapshot + ":" + entry.element_index })),
});
const FACTS: WindowsWindowFacts = {
  exists: true,
  ownerPid: PID,
  ownerMatches: true,
  sameSession: true,
  epoch: "hwnd-202003a:vd-9fb2641f254744b398a1bb1b0919cd7b:mon-10001:dpi-96",
  elevatedTarget: false,
  inputDesktop: "Default",
  focus: "clear",
};

const observe = (
  tracker: ReturnType<typeof makeObservationTracker>,
  read: DriverWindowState,
  facts: WindowsWindowFacts,
  since?: string,
) => {
  const target = windowsObservationTarget(facts);
  if ("outcome" in target) throw new Error(target.message);
  return tracker.observe({
    read: windowsDriverRead(read),
    since,
    scope: "default",
    screenshot: true,
    ...target,
  });
};

describe("Windows computer use observations (conformance)", () => {
  it("keeps refs across a real window's change and reaches the driver's new tokens", () => {
    let id = 0;
    const tracker = makeObservationTracker(() => "o" + ++id);
    const first = observe(tracker, fixtureRead("s00000001"), FACTS);
    assert.equal(first.kind, "full");
    assert.equal(first.target.epoch, FACTS.epoch);
    assert.deepEqual(first.screenshot, { mimeType: "image/png", width: 420, height: 260 });
    const refs = first.kind === "full" ? first.elements : [];
    const note = refs.find((entry) => entry.label === "Note")?.ref ?? "";
    // After set_value on Note and an Invoke on Agree, as the fixture run did.
    const second = observe(
      tracker,
      fixtureRead("s00000003", "hello from GOAT", true),
      FACTS,
      first.observationId,
    );
    assert.equal(second.kind, "diff");
    if (second.kind !== "diff") return;
    // The toggled Agree box shows up as checked, and was unchecked before (#1231, #1286).
    const agree = refs.find((entry) => entry.label === "Agree")?.ref ?? "";
    assert.deepEqual(refs.find((entry) => entry.ref === agree)?.state, { checked: false });
    assert.deepEqual(
      second.changed.map((entry) => [entry.label, entry.ref, entry.value, entry.state]),
      [
        ["Note", note, "hello from GOAT", undefined],
        ["Agree", agree, undefined, { checked: true }],
      ],
    );
    assert.deepEqual([second.added, second.removed], [[], []]);
    assert.deepEqual(
      tracker.resolve({
        pid: PID,
        windowId: WINDOW,
        observationId: second.observationId,
        element: note,
      }),
      { token: "s00000003:0" },
    );
  });

  it("starts a new lineage when the helper's epoch changes, and old refs are stale", () => {
    let id = 0;
    const tracker = makeObservationTracker(() => "o" + ++id);
    const first = observe(tracker, fixtureRead("s00000001"), FACTS);
    const ref = first.kind === "full" ? (first.elements[0]?.ref ?? "") : "";
    // The window moved to a 150% monitor.
    const moved = observe(
      tracker,
      fixtureRead("s00000002"),
      { ...FACTS, epoch: (FACTS.epoch ?? "").replace("dpi-96", "dpi-144") },
      first.observationId,
    );
    assert.equal(moved.kind, "full");
    assert.equal(moved.kind === "full" ? moved.reason : "", "epoch_changed");
    const stale = tracker.resolve({
      pid: PID,
      windowId: WINDOW,
      observationId: first.observationId,
      element: ref,
    });
    assert.equal("reason" in stale ? stale.reason : "", "staleElement");
  });

  it("sends nothing of the window while a password field has focus or focus is unknown", () => {
    for (const focus of ["secure", "unknown"] as const) {
      let id = 0;
      const tracker = makeObservationTracker(() => "o" + ++id);
      const first = observe(tracker, fixtureRead("s00000001"), FACTS);
      const ref = first.kind === "full" ? (first.elements[0]?.ref ?? "") : "";
      const hidden = observe(tracker, fixtureRead("s00000004"), { ...FACTS, focus });
      assert.deepEqual(
        { ...hidden, observationId: "", lineage: "" },
        {
          observationId: "",
          lineage: "",
          target: { pid: PID, windowId: WINDOW, epoch: FACTS.epoch ?? "" },
          complete: false,
          privateMode: true,
          kind: "full",
          reason: "incomplete",
          elements: [],
        },
      );
      const refused = tracker.resolve({
        pid: PID,
        windowId: WINDOW,
        observationId: hidden.observationId,
        element: ref,
      });
      assert.equal("reason" in refused ? refused.reason : "", "privateMode");
    }
  });

  it("refuses windows it must not touch, each with its own reason", () => {
    const cases: ReadonlyArray<[Partial<WindowsWindowFacts>, string]> = [
      [{ exists: false }, "windowNotFound"],
      [{ ownerMatches: false }, "ownerMismatch"],
      [{ sameSession: false }, "targetRefused"],
      [{ elevatedTarget: true }, "targetRefused"],
      [{ inputDesktop: "Winlogon" }, "screenLocked"],
      [{ epoch: "" }, "helperUnavailable"],
    ];
    for (const [change, reason] of cases) {
      const result = windowsObservationTarget({ ...FACTS, ...change });
      assert.equal("reason" in result ? result.reason : "admitted", reason, JSON.stringify(change));
    }
  });

  it("reports mixed and expanded state from the helper's UI Automation read, joined by place", () => {
    const at = (x: number) => ({ x, y: 100, w: 40, h: 20 });
    const read: DriverWindowState = {
      pid: PID,
      window_id: WINDOW,
      elements: [
        // Indeterminate: the driver leaves selected out.
        { element_index: 0, role: "CheckBox", label: "All", actions: ["toggle"], frame: at(0) },
        { element_index: 1, role: "TreeItem", label: "Docs", actions: ["expand"], frame: at(50) },
        { element_index: 2, role: "TreeItem", label: "Src", actions: ["expand"], frame: at(100) },
        { element_index: 3, role: "TreeItem", label: "README", frame: at(150) },
        { element_index: 4, role: "ComboBox", label: "Size", actions: ["expand"], frame: at(200) },
        // The helper names two elements here, so neither is used.
        {
          element_index: 5,
          role: "CheckBox",
          label: "Twin",
          selected: true,
          actions: ["toggle"],
          frame: at(250),
        },
        // Two driver elements in one place under one label: the helper's entry fits either, so
        // neither takes it, and the list item keeps its own selected.
        { element_index: 6, role: "ListItem", label: "Pair", selected: true, frame: at(300) },
        { element_index: 7, role: "ListItem", label: "Pair", selected: false, frame: at(300) },
      ],
    };
    const joined = windowsDriverRead(read, {
      truncated: false,
      elements: [
        { frame: at(0), role: "CheckBox", label: "All", toggle: "indeterminate" },
        { frame: at(50), role: "TreeItem", label: "Docs", expand: "collapsed" },
        { frame: at(100), role: "TreeItem", label: "Src", expand: "partial" },
        { frame: at(150), role: "TreeItem", label: "README", expand: "leaf" },
        // Same place, another name: not this element.
        { frame: at(200), role: "ComboBox", label: "Font", expand: "expanded" },
        { frame: at(250), role: "CheckBox", label: "Twin", toggle: "off" },
        { frame: at(250), role: "CheckBox", label: "Twin", toggle: "on" },
        { frame: at(300), role: "ListItem", label: "Pair", toggle: "indeterminate" },
      ],
    });
    const tracker = makeObservationTracker(() => "o1");
    const target = windowsObservationTarget(FACTS);
    if ("outcome" in target) throw new Error(target.message);
    const observed = tracker.observe({
      read: joined,
      scope: "default",
      screenshot: false,
      ...target,
    });
    assert.equal(observed.kind, "full");
    assert.deepEqual(
      observed.kind === "full"
        ? observed.elements.map((element) => [element.label, element.state])
        : [],
      [
        ["All", { checked: "mixed" }],
        ["Docs", { expanded: false }],
        ["Src", { expanded: true }],
        ["README", undefined],
        ["Size", undefined],
        ["Twin", { checked: true }],
        ["Pair", { selected: true }],
        ["Pair", { selected: false }],
      ],
    );
    // Part of the tree cannot show an entry is unique, so a truncated answer adds nothing.
    const partial = windowsDriverRead(read, {
      truncated: true,
      elements: [{ frame: at(0), role: "CheckBox", label: "All", toggle: "indeterminate" }],
    });
    assert.equal(partial.elements?.[0]?.checked, undefined);
  });
});

// The helper's permissions answer from a signed-in console session on mini.
const READY: WindowsHelperReadiness = {
  interactiveSession: true,
  sessionId: 1,
  consoleSessionId: 1,
  connectState: "active",
  inputDesktop: "Default",
  uiAutomation: true,
  helperElevated: false,
};

describe("Windows computer use readiness", () => {
  it("is ready only with a real capture and tree read, and names blockers by type", () => {
    const proof = { capture: "ready", tree: "ready" } as const;
    const ready = windowsComputerUseReadiness({ facts: READY, helper: "authenticated", proof });
    assert.isTrue(computerUseReady(ready));
    assert.deepEqual(ready.reasons, []);
    assert.isFalse(
      computerUseReady(windowsComputerUseReadiness({ facts: READY, helper: "authenticated" })),
    );
    // Without a real read, capture and the tree are each not ready, each with its own reason.
    assert.deepEqual(
      windowsComputerUseReadiness({ facts: READY, helper: "authenticated" }).reasons,
      [
        "Computer use has not captured a window yet. Run the check.",
        "Computer use has not read a window's controls yet. Run the check.",
      ],
    );
    // Session 0, as the helper answers there (#1216).
    const service = windowsComputerUseReadiness({
      facts: {
        ...READY,
        interactiveSession: false,
        sessionId: null,
        connectState: "none",
        inputDesktop: "unavailable",
        uiAutomation: false,
        helperElevated: true,
      },
      helper: "authenticated",
      proof,
    });
    assert.deepEqual(service.blockers, ["noInteractiveDesktop"]);
    assert.include(service, { capture: "unavailable", tree: "unavailable", input: "unavailable" });
    const locked = windowsComputerUseReadiness({
      facts: { ...READY, inputDesktop: "Winlogon" },
      helper: "authenticated",
      proof,
    });
    assert.deepEqual(locked.blockers, ["screenLocked"]);
    const away = windowsComputerUseReadiness({
      facts: { ...READY, sessionId: 2, connectState: "disconnected" },
      helper: "authenticated",
      proof,
    });
    assert.deepEqual(away.blockers, ["otherUserAtConsole"]);
    for (const readiness of [service, locked, away]) {
      assert.isFalse(computerUseReady(readiness));
      assert.isNotEmpty(readiness.reasons);
    }
  });
});
