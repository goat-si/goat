import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ChannelWorkerObservation,
  ChannelWorkerResult,
  channelWorkerObservationEquals,
} from "./channelWorkerObservation.ts";
import { ThreadResultReport } from "./threadResult.ts";

const decodeReport = Schema.decodeUnknownSync(ThreadResultReport);

describe("channel run evidence contract", () => {
  const decode = Schema.decodeUnknownSync(ChannelWorkerObservation);
  const base = {
    pullRequests: [],
    needsYou: [],
    result: { runId: "run-1", tests: { ok: true }, observedCheckPending: true },
  };
  const check = {
    status: "completed",
    command: "vp test run",
    exitCode: 1,
    durationMs: 1250,
    at: "2026-10-12T00:00:00.000Z",
    outputTail: "failed",
  };
  it("decodes old observations and lets an older reader ignore new result evidence", () => {
    const {
      reportedOutcome: _outcome,
      observedCheck: _check,
      observedCheckPending: _pending,
      ...oldResultFields
    } = ChannelWorkerResult.fields;
    const old = Schema.decodeUnknownSync(
      Schema.Struct({
        ...ChannelWorkerObservation.fields,
        result: Schema.optional(Schema.Struct(oldResultFields)),
      }),
    );
    const legacy = {
      pullRequests: [],
      needsYou: [],
      result: { runId: "run-1", tests: { ok: true } },
    };
    const newer = {
      ...legacy,
      result: {
        ...legacy.result,
        reportedOutcome: "succeeded",
        observedCheck: check,
        observedCheckPending: false,
      },
    };
    expect(decode(legacy)).toEqual(legacy);
    expect(decode(newer)).toEqual(newer);
    expect(old(newer)).toEqual(legacy);
  });
  it("recognizes the formal outcome of a remote worker", () => {
    const before = decode(base);
    const after = decode({ ...base, result: { ...base.result, reportedOutcome: "succeeded" } });
    expect(channelWorkerObservationEquals(before, after)).toBe(false);
  });
  it("round-trips independent claims and checks, and recognizes a late result", () => {
    const before = decode(base);
    const after = decode({
      ...base,
      result: { ...base.result, observedCheckPending: false, observedCheck: check },
    });
    expect(after.result?.tests?.ok).toBe(true);
    expect(after.result?.observedCheck?.exitCode).toBe(1);
    expect(channelWorkerObservationEquals(before, after)).toBe(false);
    expect(channelWorkerObservationEquals(after, decode(JSON.parse(JSON.stringify(after))))).toBe(
      true,
    );
    expect(decode({ pullRequests: [], needsYou: [] }).result).toBeUndefined();
  });
  it("keeps observed evidence out of the agent report input", () => {
    const reported = decodeReport({
      outcome: "succeeded",
      tests: { ok: true },
      observedCheck: check,
      observedCheckPending: false,
    });
    expect(reported).toEqual({ outcome: "succeeded", tests: { ok: true } });
    expect(() =>
      decode({
        ...base,
        result: { ...base.result, observedCheck: { ...check, status: "failed" } },
      }),
    ).toThrow();
  });
  it("preserves a remote approval's environment and distinguishes it from an alias-only ref", () => {
    const approval = { requestId: "request-1", threadId: "thread-1", host: "studio" };
    const observation = (ref: typeof approval & { environmentId?: string }) =>
      decode({
        ...base,
        needsYou: [{ kind: "approval", since: check.at, approval: ref }],
      });
    const legacy = observation(approval);
    const bound = observation({ ...approval, environmentId: "studio-old" });
    expect(legacy.needsYou[0]?.approval).toEqual(approval);
    expect(bound.needsYou[0]?.approval?.environmentId).toBe("studio-old");
    expect(channelWorkerObservationEquals(legacy, bound)).toBe(false);
    expect(
      channelWorkerObservationEquals(
        bound,
        observation({ ...approval, environmentId: "studio-new" }),
      ),
    ).toBe(false);
  });
});
