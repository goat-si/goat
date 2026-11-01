import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HostStatusEntry } from "./hostStatus.ts";
import { GoatHubDeviceVerifyResult, HubParityEvidence } from "./hubParity.ts";

const decodeOptional = Schema.decodeUnknownSync(
  Schema.Struct({ parity: HostStatusEntry.fields.parity }),
);
const decodeResult = Schema.decodeUnknownSync(GoatHubDeviceVerifyResult);
const decodeEvidence = Schema.decodeUnknownSync(HubParityEvidence);

it("parity is additive, and unknown future verdicts do not break host telemetry", () => {
  expect(decodeOptional({})).toEqual({});
  expect(
    decodeOptional({ parity: { verdict: "future", checkedAt: 0, failingCheckIds: [], checks: [] } })
      .parity,
  ).toBeUndefined();
  const result = decodeResult({
    deviceAlias: "box",
    parity: {
      verdict: "degraded",
      checkedAt: 100,
      failingCheckIds: ["P6"],
      checks: [{ id: "P6", status: "failed", reason: "Settings record missing." }],
    },
  });
  expect(decodeOptional({ parity: result.parity }).parity).toEqual(result.parity);
});

it("evidence drops raw documents and credentials", () => {
  const evidence = decodeEvidence({
    observedAt: 0,
    settingsDigest: "fixture-digest",
    token: "fixture-private",
    rawSettings: { secret: "fixture-private" },
  });
  expect(evidence).toEqual({ observedAt: 0, settingsDigest: "fixture-digest" });
});
