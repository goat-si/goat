import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_MAX_FRAME_BYTES,
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseActionResult,
  ComputerUseCapabilities,
  ComputerUseElement,
  ComputerUseEventFrame,
  ComputerUseWatchRequest,
  ComputerUseActionRequest,
  ComputerUseHelloReply,
  ComputerUseKey,
  ComputerUseObservation,
  ComputerUseReadiness,
  ComputerUseRequestFrame,
  admitComputerUseReply,
  admitComputerUseEvent,
  computerUseDeadlineResult,
  computerUseNextStep,
  computerUseImageInfo,
  computerUseReady,
  computerUseReplyImageProblem,
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
      signals: { privateMode: "unsupported", humanInput: "unsupported" },
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
        signals: { privateMode: "supported", humanInput: "supported" },
      },
    };
    expect(decodes(ComputerUseHelloReply, { ...hello, maxFrameBytes: 1024 * 1024 })).toBe(true);
    expect(decodes(ComputerUseHelloReply, { ...hello, maxFrameBytes: 16 })).toBe(false);
  });
});

// An 8x6 PNG and the same picture as JPEG (sips), as base64.
const PNG_8X6 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAD0lEQVR4nGNowAEYBlICABnRSAEtC4j6AAAAAElFTkSuQmCC";
const JPEG_8X6 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAABgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABgAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8AKKKKAP/Z";

describe("computer use readiness and reply images", () => {
  const decodes = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
    Schema.decodeUnknownExit(schema)(value)._tag === "Success";
  const ready = {
    grants: { accessibility: "granted", screenCapture: "granted" },
    helper: "authenticated",
    capture: "ready",
    tree: "ready",
    input: "background",
    blockers: [],
    reasons: [],
  } as const;

  it("reports each readiness step on its own, so an unproven step is never shown as done", () => {
    const portalPending = {
      ...ready,
      grants: { accessibility: "granted", screenCapture: "pending" },
      capture: "pending",
      reasons: ["Allow screen sharing in the dialog GNOME opened."],
      platform: { linux: { displayServer: "wayland" } },
    };
    expect(decodes(ComputerUseReadiness, portalPending)).toBe(true);
    expect(computerUseReady(Schema.decodeUnknownSync(ComputerUseReadiness)(portalPending))).toBe(
      false,
    );
    expect(decodes(ComputerUseReadiness, { ...portalPending, capture: "granted" })).toBe(false);
    expect(
      decodes(ComputerUseReadiness, {
        ...ready,
        grants: { accessibility: true, screenCapture: true },
      }),
    ).toBe(false);
    expect(computerUseReady(ready)).toBe(true);
  });

  it.each([
    { platform: "a locked Mac", blockers: ["screenLocked"] },
    { platform: "Windows reached over SSH (Session 0)", blockers: ["noInteractiveDesktop"] },
    { platform: "a Mac whose grant changed while the helper ran", blockers: ["restartRequired"] },
  ])("is not ready on $platform even with every step proven", ({ blockers }) => {
    const blocked = Schema.decodeUnknownSync(ComputerUseReadiness)({ ...ready, blockers });
    expect(computerUseReady(blocked)).toBe(false);
  });

  it.each([
    { name: "a PNG cut off inside its header", data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAG" },
    {
      name: "a PNG whose IHDR has the wrong length",
      data: "iVBORw0KGgoAAAAMSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAD0lEQVR4nGNowAEYBlICABnRSAEtC4j6AAAAAElFTkSuQmCC",
    },
    {
      name: "a PNG whose IHDR checksum is wrong",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAACOZ0isAAAAD0lEQVR4nGNowAEYBlICABnRSAEtC4j6AAAAAElFTkSuQmCC",
    },
    { name: "a JPEG whose frame header is cut short", data: "/9j/wAARCAAGAAg=" },
    { name: "a JPEG frame header of length zero", data: "/9j/wAAACAAGAAgDAAAAAAAAAAAA" },
    { name: "a JPEG with a frame header after its end", data: "/9j/2f/AABEIAAYACAMBIgACEQEDEQE=" },
    // Checksummed correctly, so only the method checks can refuse them.
    {
      name: "a PNG with an undefined compression method",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIBAABwpSKbAAAAD0lEQVR4nGNowAEYBlICABnRSAEtC4j6AAAAAElFTkSuQmCC",
    },
    {
      name: "a PNG with an undefined filter method",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAQBofHntAAAAD0lEQVR4nGNowAEYBlICABnRSAEtC4j6AAAAAElFTkSuQmCC",
    },
    {
      name: "a PNG with an undefined interlace method",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAAKfaSmAAAAAD0lEQVR4nGNowAEYBlICABnRSAEtC4j6AAAAAElFTkSuQmCC",
    },
    { name: "a JPEG frame header too short for one component", data: "/9j/wAAC" },
  ])("refuses $name", ({ data }) => {
    expect(computerUseImageInfo(data)).toBeUndefined();
  });

  it("reads an image's real format and size from its bytes", () => {
    expect(computerUseImageInfo(PNG_8X6)).toEqual({ mimeType: "image/png", width: 8, height: 6 });
    expect(computerUseImageInfo(JPEG_8X6)).toEqual({ mimeType: "image/jpeg", width: 8, height: 6 });
    for (const bad of ["iVBORw0KGgo=", "not base64!", "", "AAAA"])
      expect(computerUseImageInfo(bad)).toBeUndefined();
  });

  it("accepts an image only beside an observation that declares exactly that screenshot, never a private one", () => {
    const observed = {
      observationId: "o1",
      lineage: "l1",
      kind: "full",
      reason: "first",
      target: { pid: 1, windowId: 2, epoch: "e" },
      complete: true,
      privateMode: false,
      screenshot: { mimeType: "image/png", width: 8, height: 6 },
      elements: [],
    } as const;
    const png = { mimeType: "image/png", data: PNG_8X6 };
    expect(computerUseReplyImageProblem(observed, png)).toBeUndefined();
    expect(computerUseReplyImageProblem(observed, undefined)).toBeUndefined();
    // Points are pixels of the declared screenshot, so the size must match exactly.
    expect(
      computerUseReplyImageProblem(
        { ...observed, screenshot: { mimeType: "image/png", width: 16, height: 12 } },
        png,
      ),
    ).toMatch(/8x6/);
    // The label must match the bytes, not just the observation.
    expect(
      computerUseReplyImageProblem(observed, { mimeType: "image/png", data: JPEG_8X6 }),
    ).toMatch(/image\/jpeg/);
    expect(computerUseReplyImageProblem(observed, { ...png, data: "iVBORw0KGgo=" })).toMatch(
      /readable/,
    );
    const { screenshot: _screenshot, ...withoutScreenshot } = observed;
    expect(computerUseReplyImageProblem(withoutScreenshot, png)).toBeDefined();
    expect(computerUseReplyImageProblem(undefined, png)).toBeDefined();
    expect(
      computerUseReplyImageProblem(
        { ...withoutScreenshot, privateMode: true, complete: false, reason: "incomplete" },
        png,
      ),
    ).toMatch(/private/);
  });
});

describe("computer use safety signals", () => {
  const decodes = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
    Schema.decodeUnknownExit(schema)(value)._tag === "Success";
  const capabilities = {
    protocol: 1,
    platform: "linux",
    methods: Object.fromEntries(COMPUTER_USE_METHODS.map((method) => [method, "supported"])),
    backgroundDelivery: true,
    signals: { privateMode: "supported", humanInput: "unsupported" },
  };

  it("makes every helper say whether it can raise each safety signal", () => {
    expect(decodes(ComputerUseCapabilities, capabilities)).toBe(true);
    const { signals: _signals, ...silent } = capabilities;
    expect(decodes(ComputerUseCapabilities, silent)).toBe(false);
    expect(
      decodes(ComputerUseCapabilities, { ...capabilities, signals: { privateMode: "supported" } }),
    ).toBe(false);
  });

  it("accepts events only from the current helper generation and within the frame limit", () => {
    const frame = Schema.decodeUnknownSync(ComputerUseEventFrame)({
      generation: "g2",
      watchId: "w1",
      event: { type: "privateMode", active: true, target: { pid: 10, windowId: 20 } },
    });
    const admit = (generation: string, frameBytes = 120, watchId: string | undefined = "w1") =>
      admitComputerUseEvent({ frame, frameBytes, maxFrameBytes: 64 * 1024, generation, watchId });
    expect(admit("g2")).toBe("deliver");
    expect(admit("g3")).toBe("wrongGeneration");
    expect(admit("g2", 70 * 1024)).toBe("frameTooLarge");
    // A later watch in the same helper, or none at all, never sees this watch's events.
    expect(admit("g2", 120, "w2")).toBe("notWatching");
    expect(
      admitComputerUseEvent({
        frame,
        frameBytes: 120,
        maxFrameBytes: 64 * 1024,
        generation: "g2",
        watchId: undefined,
      }),
    ).toBe("notWatching");
    expect(
      decodes(ComputerUseEventFrame, {
        generation: "g2",
        watchId: "w1",
        event: { type: "humanInput", source: "pointer" },
      }),
    ).toBe(true);
    expect(
      decodes(ComputerUseEventFrame, {
        generation: "g2",
        watchId: "w1",
        event: { type: "humanInput", source: "touch" },
      }),
    ).toBe(false);
    // Events carry no content: a typed-text field does not survive decoding.
    const typed = Schema.decodeUnknownSync(ComputerUseEventFrame)({
      generation: "g2",
      watchId: "w1",
      event: { type: "humanInput", source: "keyboard", text: "hunter2" },
    });
    expect(JSON.stringify(typed)).not.toContain("hunter2");
  });

  it("watches at least one window, and reports who the helper is to the OS", () => {
    expect(
      decodes(ComputerUseWatchRequest, { watchId: "w1", targets: [{ pid: 1, windowId: 2 }] }),
    ).toBe(true);
    expect(decodes(ComputerUseWatchRequest, { watchId: "w1", targets: [] })).toBe(false);
    expect(decodes(ComputerUseWatchRequest, { targets: [{ pid: 1, windowId: 2 }] })).toBe(false);
    const diagnosed = {
      grants: { accessibility: "denied", screenCapture: "granted" },
      helper: "authenticated",
      capture: "ready",
      tree: "unavailable",
      input: "background",
      blockers: [],
      reasons: ["Accessibility is off for GOAT Computer Use."],
      diagnostics: {
        executable:
          "/Applications/GOAT.app/Contents/Helpers/GOAT Computer Use.app/Contents/MacOS/GOAT Computer Use",
        pid: 4100,
        responsiblePid: 4100,
        codeRequirement: 'identifier "si.goat.desktop.computer-use" and anchor apple generic',
        accessibilityTrusted: false,
      },
    };
    expect(decodes(ComputerUseReadiness, diagnosed)).toBe(true);
  });
});

describe("computer use watch ordering", () => {
  it("delivers the old watch's clearing event and the new watch's initial state across a rewatch", () => {
    const target = { pid: 10, windowId: 20 };
    const frame = (watchId: string, active: boolean) =>
      Schema.decodeUnknownSync(ComputerUseEventFrame)({
        generation: "g1",
        watchId,
        event: { type: "privateMode", active, target },
      });
    // The client's watch in force changes only when the helper answers the new watch.
    let inForce: string | undefined = "w1";
    const admit = (event: ReturnType<typeof frame>) =>
      admitComputerUseEvent({
        frame: event,
        frameBytes: 120,
        maxFrameBytes: 64 * 1024,
        generation: "g1",
        watchId: inForce,
      });

    // The client sends watch w2, which drops the target that was private. Before answering, the
    // helper clears it under w1, and the client, still on w1, receives it.
    expect(admit(frame("w1", false))).toBe("deliver");
    // The answer arrives; from now on w2 is in force.
    inForce = "w2";
    // The new watch's initial state follows under w2.
    expect(admit(frame("w2", false))).toBe("deliver");
    // Anything still in flight from w1 is dropped.
    expect(admit(frame("w1", true))).toBe("notWatching");
    // After unwatch is answered nothing is in force.
    inForce = undefined;
    expect(admit(frame("w2", false))).toBe("notWatching");
  });
});

describe("computer use element state values", () => {
  it("carries checked, selected, enabled and expanded, with mixed for an indeterminate box", () => {
    const decode = Schema.decodeUnknownExit(ComputerUseElement);
    const element = { ref: "l:1", role: "CheckBox", label: "Agree", actions: ["Toggle"] };
    expect(decode({ ...element, state: { checked: "mixed", enabled: true } })._tag).toBe("Success");
    expect(
      decode({ ...element, state: { checked: true, selected: false, expanded: false } })._tag,
    ).toBe("Success");
    expect(decode({ ...element, state: { checked: "on" } })._tag).toBe("Failure");
  });
});
