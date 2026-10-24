import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_MAX_FRAME_BYTES,
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseActionResult,
  ComputerUseCapabilities,
  ComputerUseActionRequest,
  ComputerUseHelloReply,
  ComputerUseKey,
  ComputerUseObservation,
  ComputerUseRequestFrame,
  admitComputerUseReply,
  computerUseDeadlineResult,
  computerUseNextStep,
  negotiateComputerUseVersion,
  unsupportedComputerUseMethod,
  type ComputerUseActionResult as ActionResult,
} from "./computerUseProtocol.ts";

const decodeCapabilities = Schema.decodeUnknownExit(ComputerUseCapabilities);
const decodeResult = Schema.decodeUnknownSync(ComputerUseActionResult);
const decodeObservation = Schema.decodeUnknownSync(ComputerUseObservation);

const allMethods = (support: "supported" | "unsupported") =>
  Object.fromEntries(COMPUTER_USE_METHODS.map((method) => [method, support]));

describe("computer use helper protocol", () => {
  it("rejects a helper whose capabilities leave a method out, so every platform answers for all", () => {
    const complete = {
      protocol: 1,
      platform: "linux",
      methods: allMethods("unsupported"),
      backgroundDelivery: false,
    };
    expect(decodeCapabilities(complete)._tag).toBe("Success");
    const { drag: _drag, ...missing } = allMethods("supported");
    expect(decodeCapabilities({ ...complete, methods: missing })._tag).toBe("Failure");
  });

  it("names the method and platform in an unsupported refusal", () => {
    const refusal = decodeResult(unsupportedComputerUseMethod("drag", "windows"));
    expect(refusal).toMatchObject({
      outcome: "refused",
      reason: "unsupported",
      method: "drag",
      platform: "windows",
    });
    expect(computerUseNextStep(refusal)).toBe("stop");
  });

  it("never replays input that may have landed; only an undispatched busy refusal is retried", () => {
    const sent = (outcome: string, dispatch: string): ActionResult =>
      decodeResult({ outcome, dispatch, delivery: "background" });
    const refused = (reason: string): ActionResult =>
      decodeResult({ outcome: "refused", reason, message: reason });
    expect(computerUseNextStep(sent("confirmed", "verified"))).toBe("done");
    expect(computerUseNextStep(sent("partial", "dispatched_unknown"))).toBe("observe");
    expect(computerUseNextStep(sent("unverifiable", "dispatched_unknown"))).toBe("observe");
    expect(computerUseNextStep(sent("suspected_noop", "verified"))).toBe("observe");
    expect(computerUseNextStep(refused("busy"))).toBe("retry");
    expect(computerUseNextStep(refused("staleElement"))).toBe("observe");
    expect(computerUseNextStep(refused("epochChanged"))).toBe("observe");
    // A deadline is not a refusal: the input may have landed, so it is observed, never resent.
    expect(computerUseNextStep(computerUseDeadlineResult("background"))).toBe("observe");
    // A person taking over, a Stop, a policy refusal and a missing grant are distinct (#1146).
    for (const reason of [
      "userIntervened",
      "userStoppedSession",
      "targetRefused",
      "permissionsNotGranted",
      "privateMode",
    ])
      expect(computerUseNextStep(refused(reason))).toBe("stop");
  });

  it("quarantines replies from another generation, to requests no longer pending, or oversized", () => {
    const reply = { id: "7", generation: "g2", result: {} };
    const admit = (
      generation: string,
      pending: string[],
      frameBytes = 100,
      maxFrameBytes = COMPUTER_USE_MAX_FRAME_BYTES,
    ) =>
      admitComputerUseReply({
        reply,
        frameBytes,
        maxFrameBytes,
        generation,
        pending: new Set(pending),
      });
    expect(admit("g2", ["7"])).toBe("deliver");
    // The helper restarted: a late answer from the old process never reaches the caller.
    expect(admit("g3", ["7"])).toBe("wrongGeneration");
    // Stop cancelled the request; its late result is dropped.
    expect(admit("g2", [])).toBe("notPending");
    expect(admit("g2", ["7"], COMPUTER_USE_MAX_FRAME_BYTES + 1)).toBe("frameTooLarge");
    // The limit the hello agreed on, not the protocol maximum.
    expect(admit("g2", ["7"], 70 * 1024, 64 * 1024)).toBe("frameTooLarge");
  });

  it("refuses a helper on another protocol version before any work", () => {
    expect(negotiateComputerUseVersion(COMPUTER_USE_PROTOCOL_VERSION)).toBe(true);
    expect(negotiateComputerUseVersion(COMPUTER_USE_PROTOCOL_VERSION + 1)).toMatchObject({
      outcome: "refused",
      reason: "incompatibleClientVersion",
    });
  });

  it("keeps screenshot bytes out of observations; they travel as MCP image content", () => {
    const observation = decodeObservation({
      observationId: "o2",
      lineage: "l1",
      kind: "diff",
      since: "o1",
      target: { pid: 10, windowId: 20, epoch: "e1" },
      complete: true,
      privateMode: false,
      screenshot: { mimeType: "image/png", width: 800, height: 600, data: "iVBORw0KGgo=" },
      added: [],
      changed: [{ ref: "e7", role: "AXButton", label: "Save", actions: ["AXPress"] }],
      removed: ["e3"],
    });
    expect(observation.screenshot).toEqual({ mimeType: "image/png", width: 800, height: 600 });
  });
});

describe("computer use protocol values", () => {
  const decodes = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
    Schema.decodeUnknownExit(schema)(value)._tag === "Success";

  it("accepts only outcome and dispatch pairs that make sense", () => {
    expect(
      decodes(ComputerUseActionResult, {
        outcome: "confirmed",
        dispatch: "verified",
        delivery: "background",
      }),
    ).toBe(true);
    expect(
      decodes(ComputerUseActionResult, {
        outcome: "confirmed",
        dispatch: "dispatched_unknown",
        delivery: "background",
      }),
    ).toBe(false);
    expect(
      decodes(ComputerUseActionResult, {
        outcome: "unverifiable",
        dispatch: "verified",
        delivery: "background",
      }),
    ).toBe(false);
    expect(
      decodes(ComputerUseActionResult, {
        outcome: "partial",
        dispatch: "not_dispatched",
        delivery: "background",
      }),
    ).toBe(false);
  });

  it("names keys by meaning, so every platform reads a request the same way", () => {
    for (const key of ["a", "/", "\u{10400}", "enter", "arrowLeft", "f12"])
      expect(decodes(ComputerUseKey, key)).toBe(true);
    // Controls, a lone surrogate and two characters are not one printable key.
    for (const key of ["ctrl+a", "Return", "", "f25", "\n", "\u0000", "\uD800", "ab"])
      expect(decodes(ComputerUseKey, key)).toBe(false);
  });

  it("bounds scroll amounts, deadlines and frame limits", () => {
    const scroll = {
      target: { pid: 1, windowId: 2, epoch: "e" },
      observationId: "o",
      delivery: "background",
      action: "scroll",
      at: { x: 1, y: 1 },
      direction: "down",
    };
    expect(decodes(ComputerUseActionRequest, { ...scroll, amount: 3 })).toBe(true);
    expect(decodes(ComputerUseActionRequest, { ...scroll, amount: 0 })).toBe(false);
    const frame = { id: "1", generation: "g", method: "observe", params: {} };
    expect(decodes(ComputerUseRequestFrame, { ...frame, deadlineMs: 5000 })).toBe(true);
    expect(decodes(ComputerUseRequestFrame, { ...frame, deadlineMs: 0 })).toBe(false);
    const hello = {
      serverApiVersion: 1,
      binding: { executable: "/h", pid: 1, generation: "g" },
      capabilities: {
        protocol: 1,
        platform: "mac",
        methods: allMethods("supported"),
        backgroundDelivery: true,
      },
    };
    expect(decodes(ComputerUseHelloReply, { ...hello, maxFrameBytes: 1024 * 1024 })).toBe(true);
    expect(decodes(ComputerUseHelloReply, { ...hello, maxFrameBytes: 16 })).toBe(false);
  });
});
