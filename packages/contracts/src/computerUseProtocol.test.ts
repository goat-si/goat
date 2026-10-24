import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_MAX_FRAME_BYTES,
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseActionResult,
  ComputerUseCapabilities,
  ComputerUseObservation,
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
    const admit = (generation: string, pending: string[], frameBytes = 100) =>
      admitComputerUseReply({ reply, frameBytes, generation, pending: new Set(pending) });
    expect(admit("g2", ["7"])).toBe("deliver");
    // The helper restarted: a late answer from the old process never reaches the caller.
    expect(admit("g3", ["7"])).toBe("wrongGeneration");
    // Stop cancelled the request; its late result is dropped.
    expect(admit("g2", [])).toBe("notPending");
    expect(admit("g2", ["7"], COMPUTER_USE_MAX_FRAME_BYTES + 1)).toBe("frameTooLarge");
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
