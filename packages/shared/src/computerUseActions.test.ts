import { computerUseNextStep, type ComputerUseActionRequest } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { actionResultFromDriver, driverCallFor, type ActionContext } from "./computerUseActions.ts";
import { makeObservationTracker, type DriverWindowState } from "./computerUseObservation.ts";

const read = (snapshot: number): DriverWindowState => ({
  pid: 10,
  window_id: 20,
  truncated: false,
  screenshot_width: 800,
  screenshot_height: 600,
  window_bounds: { width: 400, height: 300 },
  elements: [
    { element_index: 0, element_token: "s" + snapshot + ":0", role: "AXGroup", label: "Form" },
    {
      element_index: 1,
      element_token: "s" + snapshot + ":1",
      role: "AXButton",
      label: "Save",
      parent_index: 0,
      actions: ["AXPress"],
      screenshot_frame: { x: 100, y: 40, w: 60, h: 20 },
    },
  ],
});

const setup = (overrides: Partial<Omit<ActionContext, "observations">> = {}) => {
  let id = 0;
  const observations = makeObservationTracker(() => "id" + ++id);
  const first = observations.observe({
    read: read(1),
    epoch: "e1",
    scope: "all",
    screenshot: true,
    privateMode: false,
  });
  if (first.kind !== "full") throw new Error("expected a full observation");
  const save = first.elements[1]!.ref;
  const context: ActionContext = {
    observations,
    foregroundAllowed: false,
    privateMode: false,
    ...overrides,
  };
  const request = (action: Record<string, unknown>) =>
    ({
      target: { pid: 10, windowId: 20, epoch: first.target.epoch },
      observationId: first.observationId,
      delivery: "background",
      ...action,
    }) as ComputerUseActionRequest;
  return { observations, first, save, context, request };
};

describe("computer use actions", () => {
  it("sends input only to the exact window, in the background, through the element's current token", () => {
    const { observations, first, save, context, request } = setup();
    expect(driverCallFor(request({ action: "click", at: { element: save } }), context)).toEqual({
      tool: "click",
      args: { pid: 10, window_id: 20, delivery_mode: "background", element_token: "s1:1" },
    });
    // The driver re-snapshotted; the same ref reaches its new token.
    const next = observations.observe({
      read: read(2),
      since: first.observationId,
      epoch: "e1",
      scope: "all",
      screenshot: true,
      privateMode: false,
    });
    expect(
      driverCallFor(
        {
          ...request({ action: "performAction", element: save, name: "AXPress" }),
          observationId: next.observationId,
        },
        context,
      ),
    ).toMatchObject({
      tool: "click",
      args: { element_token: "s2:1", action: "press", pid: 10, window_id: 20 },
    });
  });

  it("drags an element from the center of its frame", () => {
    const { save, context, request } = setup();
    expect(
      driverCallFor(
        request({ action: "drag", from: { element: save }, to: { x: 300, y: 200 } }),
        context,
      ),
    ).toMatchObject({
      tool: "drag",
      args: { from_x: 130, from_y: 50, to_x: 300, to_y: 200 },
    });
  });

  it("refuses before sending anything", () => {
    const { observations, first, save, request } = setup();
    const refuse = (action: Record<string, unknown>, context: Partial<ActionContext> = {}) => {
      const call = driverCallFor(request(action), {
        observations,
        foregroundAllowed: false,
        privateMode: false,
        ...context,
      });
      return "outcome" in call ? call.reason : "sent";
    };
    expect(refuse({ action: "typeText", text: "secret" }, { privateMode: true })).toBe(
      "privateMode",
    );
    expect(refuse({ action: "click", at: { element: save }, delivery: "foreground" })).toBe(
      "foregroundNotAllowed",
    );
    expect(
      refuse(
        { action: "click", at: { element: save }, delivery: "foreground" },
        { foregroundAllowed: true },
      ),
    ).toBe("sent");
    expect(refuse({ action: "click", at: { element: "gone:9" } })).toBe("staleElement");
    expect(refuse({ action: "setValue", element: save, value: "x", append: true })).toBe(
      "unsupported",
    );
    expect(refuse({ action: "performAction", element: save, name: "AXRaise" })).toBe("unsupported");
    observations.observe({
      read: read(2),
      since: first.observationId,
      epoch: "e1",
      scope: "all",
      screenshot: true,
      privateMode: false,
    });
    // Pixels from an older screenshot no longer describe the window.
    expect(refuse({ action: "click", at: { x: 5, y: 5 } })).toBe("staleElement");
  });

  it("reads the driver's effect into D5 results and never confirms what the driver did not", () => {
    const { save, request } = setup();
    const click = request({ action: "click", at: { element: save } });
    const result = (structured: unknown, isError = false, text = "") =>
      actionResultFromDriver(click, { isError, text, structured });
    expect(result({ effect: "confirmed", verified: true })).toMatchObject({
      outcome: "confirmed",
      dispatch: "verified",
    });
    expect(result({ effect: "partial", code: "type_text_incomplete" })).toMatchObject({
      outcome: "partial",
      dispatch: "dispatched_unknown",
    });
    expect(result({ effect: "no_drop" })).toMatchObject({
      outcome: "suspected_noop",
      dispatch: "verified",
    });
    expect(result({ path: "cgevent", verified: false, effect: "unverifiable" })).toMatchObject({
      outcome: "unverifiable",
    });
    // An error with no classification may have landed: observe again, never resend.
    const unknown = result(undefined, true, "socket closed");
    expect(unknown).toMatchObject({ outcome: "unverifiable", dispatch: "dispatched_unknown" });
    expect(computerUseNextStep(unknown)).toBe("observe");
  });

  it("maps the driver's refusals to typed reasons and never to a person stopping the session", () => {
    const { save, request } = setup();
    const click = request({ action: "click", at: { element: save } });
    const reason = (code: string) => {
      const mapped = actionResultFromDriver(click, {
        isError: true,
        text: "",
        structured: { code, effect: "refused" },
      });
      return mapped.outcome === "refused" ? mapped.reason : mapped.outcome;
    };
    expect(reason("stale_element_token")).toBe("staleElement");
    expect(reason("window_owner_pid_mismatch")).toBe("ownerMismatch");
    expect(reason("background_unavailable")).toBe("backgroundUnavailable");
    expect(reason("permission_denied")).toBe("permissionsNotGranted");
    // #1146: a refusal the driver did not explain is the target's refusal, not the person's Stop.
    expect(reason("private_future_refusal")).toBe("targetRefused");
  });
});

describe("computer use keys on mac", () => {
  it("presses canonical keys under the driver's names and refuses ones it cannot press", () => {
    const { context, request } = setup();
    const press = (key: string, modifiers?: string[]) => {
      const call = driverCallFor(
        request({ action: "pressKey", key, ...(modifiers ? { modifiers } : {}) }),
        context,
      );
      return "outcome" in call ? call.reason : call.args;
    };
    expect(press("enter")).toMatchObject({ key: "return" });
    expect(press("backspace")).toMatchObject({ key: "delete" });
    expect(press("arrowLeft", ["command"])).toMatchObject({ key: "left", modifiers: ["cmd"] });
    // A chord: command-shift-z.
    expect(press("Z", ["command"])).toMatchObject({ key: "z", modifiers: ["cmd", "shift"] });
    // Forward delete and keys past f12 have no driver name on mac.
    expect(press("delete")).toBe("unsupported");
    expect(press("f13")).toBe("unsupported");
    expect(press("/")).toBe("unsupported");
  });
});

describe("computer use action review regressions", () => {
  it("does not call an error a refusal unless the driver says nothing was sent", () => {
    const { save, request } = setup();
    const click = request({ action: "pressKey", key: "a" });
    const mapped = (structured: unknown) =>
      actionResultFromDriver(click, { isError: true, text: "", structured });
    // press_key reports delivery_failed after a key may already have gone down.
    expect(mapped({ code: "delivery_failed" })).toMatchObject({
      outcome: "unverifiable",
      dispatch: "dispatched_unknown",
    });
    expect(mapped({ code: "something_new" })).toMatchObject({ outcome: "unverifiable" });
    // The snapshot store's envelope for a stale token.
    expect(
      actionResultFromDriver(request({ action: "click", at: { element: save } }), {
        isError: true,
        text: "",
        structured: {
          status: "refused",
          refusal: { code: "stale_element_token", message: "stale" },
        },
      }),
    ).toMatchObject({ outcome: "refused", reason: "staleElement" });
  });

  it("checks the window and observation before keyboard input too", () => {
    const { observations, first, context, request } = setup();
    const press = (overrides: Record<string, unknown> = {}) => {
      const call = driverCallFor(
        { ...request({ action: "pressKey", key: "a" }), ...overrides } as ComputerUseActionRequest,
        context,
      );
      return "outcome" in call ? call.reason : "sent";
    };
    expect(press()).toBe("sent");
    expect(press({ target: { pid: 10, windowId: 20, epoch: "elsewhere" } })).toBe("epochChanged");
    observations.observe({
      read: read(2),
      since: first.observationId,
      epoch: "e1",
      scope: "all",
      screenshot: true,
      privateMode: false,
    });
    expect(press()).toBe("staleElement");
    expect(driverCallFor(request({ action: "typeText", text: "hi" }), context)).toMatchObject({
      reason: "staleElement",
    });
    observations.forget(10, 20);
    expect(press({ observationId: "any" })).toBe("staleElement");
  });

  it("allows only the driver's own AX action names", () => {
    const { save, context, request } = setup();
    for (const name of ["toString", "constructor", "__proto__"])
      expect(
        driverCallFor(request({ action: "performAction", element: save, name }), context),
      ).toMatchObject({ reason: "unsupported" });
  });
});
