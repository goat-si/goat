import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ScreenHostCall,
  DEFAULT_SCREEN_RUN_LIMITS,
  ScreenHostReply,
  ScreenImage,
  ScreenRunLimits,
  ScreenRunCell,
  ScreenRunResult,
  ScreenTargetRef,
} from "./screenCode.ts";

const encodeScreenRunResult = Schema.encodeSync(ScreenRunResult);
const decodeScreenRunResult = Schema.decodeSync(ScreenRunResult);

const encodeScreenImage = Schema.encodeSync(ScreenImage);
const encodeScreenRunLimits = Schema.encodeSync(ScreenRunLimits);

const encodeScreenHostReply = Schema.encodeSync(ScreenHostReply);
const encodeScreenHostCall = Schema.encodeSync(ScreenHostCall);

const encodeScreenTargetRef = Schema.encodeSync(ScreenTargetRef);

describe("screen code wire contracts", () => {
  const target = {
    id: "target:1",
    kind: "app",
    environmentId: "environment:1",
    runId: "run:1",
    turnId: "turn:1",
    generation: 0,
  } as const;
  const call = {
    t: "call",
    runId: "run:1",
    turnId: "turn:1",
    cellId: "cell:1",
    callId: 1,
    targetRef: target,
    method: "click",
    args: { element: "element:1" },
    deadlineMillis: 100,
  } as const;

  it("roundtrips an opaque target and host call without granting extra fields", () => {
    const targetDecode = Schema.decodeUnknownSync(ScreenTargetRef);
    expect(encodeScreenTargetRef(targetDecode(target))).toEqual(target);
    const decode = Schema.decodeUnknownSync(ScreenHostCall);
    expect(encodeScreenHostCall(decode(call))).toEqual(call);
    expect(() => decode({ ...call, threadId: "thread:forged" })).toThrow();
    expect(() => decode({ ...call, method: "run_script" })).toThrow();
    expect(() => targetDecode({ ...target, generation: -1 })).toThrow();
  });

  it("bounds guest arguments and rejects extra reply authority", () => {
    const decodeCall = Schema.decodeUnknownSync(ScreenHostCall);
    expect(() => decodeCall({ ...call, args: { text: "x".repeat(64 * 1024) } })).toThrow();
    const decodeReply = Schema.decodeUnknownSync(ScreenHostReply);
    const reply = {
      t: "reply",
      runId: "run:1",
      cellId: "cell:1",
      callId: 1,
      outcome: "ok",
      value: { imageRef: "image:1" },
    };
    expect(encodeScreenHostReply(decodeReply(reply))).toEqual(reply);
    expect(() => decodeReply({ ...reply, bytes: "AAAA" })).toThrow();
    const decodeCell = Schema.decodeUnknownSync(ScreenRunCell);
    expect(() =>
      decodeCell({
        t: "cell",
        cellId: "cell:1",
        source: "한".repeat(22_000),
        resetValues: false,
        limits: DEFAULT_SCREEN_RUN_LIMITS,
        deadlineMillis: 0,
      }),
    ).toThrow();
  });

  it("caps requested limits at the GOAT ceilings", () => {
    const decode = Schema.decodeUnknownSync(ScreenRunLimits);
    const limits = {
      sourceBytes: 64 * 1024,
      cellWallMs: 30_000,
      turnWasmBytes: 64 * 1024 * 1024,
      heapBytes: 16 * 1024 * 1024,
      stackBytes: 1024 * 1024,
      callsPerCell: 64,
      pendingCalls: 4,
      argBytes: 64 * 1024,
      returnBytes: 64 * 1024,
      consoleBytes: 16 * 1024,
      treeBytes: 128 * 1024,
      imageBytes: 2 * 1024 * 1024,
      journalEntries: 64,
      activeChildren: 4,
    };
    expect(encodeScreenRunLimits(decode(limits))).toEqual(limits);
    expect(() => decode({ ...limits, pendingCalls: 5 })).toThrow();
    expect(() => decode({ ...limits, callsPerCell: 0 })).toThrow();
  });

  it("keeps image bytes in the host result and validates the decoded cap", () => {
    const image = {
      imageRef: "image:1",
      callId: 1,
      targetId: target.id,
      observationId: "observation:1",
      regionId: "region:1",
      region: { kind: "window", x: 0, y: 0, width: 1, height: 1 },
      pixelWidth: 1,
      pixelHeight: 1,
      scale: 1,
      mimeType: "image/png",
      bytes: "AA==",
    } as const;
    const decodeImage = Schema.decodeUnknownSync(ScreenImage);
    expect(encodeScreenImage(decodeImage(image))).toEqual(image);
    expect(() => decodeImage({ ...image, bytes: "!" })).toThrow();
    expect(() => decodeImage({ ...image, bytes: "AAAA".repeat(699_051) })).toThrow();
    const { bytes: _bytes, ...metadata } = image;
    const result = {
      runId: target.runId,
      turnId: target.turnId,
      cellId: "cell:1",
      status: "completed",
      console: [],
      journal: [],
      truncated: [],
      availability: [{ kind: "app", available: true }],
      imageMetadata: [metadata],
      images: [image],
    } as const;
    const decoded = decodeScreenRunResult(result);
    expect(encodeScreenRunResult(decoded)).toEqual(result);
    expect(decoded.imageMetadata[0]).not.toHaveProperty("bytes");
    expect(() =>
      decodeScreenRunResult({
        ...result,
        images: [
          { ...image, bytes: "AAAA".repeat(350_000) },
          { ...image, imageRef: "image:2", bytes: "AAAA".repeat(350_000) },
        ],
      }),
    ).toThrow();
  });
});
