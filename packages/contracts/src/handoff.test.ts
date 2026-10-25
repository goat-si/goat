import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HandoffError, HandoffHuman, HandoffSummary, HandoffJson } from "./handoff.ts";

const humanCodec = Schema.toCodecJson(HandoffHuman);
const decodeHuman = Schema.decodeUnknownSync(humanCodec);
const encodeHuman = Schema.encodeSync(humanCodec);
const decodeSummary = Schema.decodeUnknownSync(Schema.toCodecJson(HandoffSummary));

describe("private handoff trust context", () => {
  it("round-trips an optional fingerprint only in the private human payload", () => {
    const human = { location: "Home Mac", fingerprint: "SHA256:negotiated-host-key" };
    expect(decodeHuman(JSON.parse(JSON.stringify(encodeHuman(human))))).toEqual(human);
    expect(decodeHuman({ location: "Home Mac" })).toEqual({ location: "Home Mac" });
    expect(() => decodeHuman({ ...human, fingerprint: " " })).toThrow();

    const summary = {
      handoffId: "handoff-1",
      kind: "approval",
      title: "Trust this SSH host",
      state: "pending",
      expiresAt: null,
      targetPath: "ssh.host_add",
    };
    expect(decodeSummary({ ...summary, fingerprint: human.fingerprint, human })).toEqual(summary);
  });
});

// The error as clients before #921 decode it: reason is a closed set, other fields are ignored.
class LegacyHandoffError extends Schema.TaggedError<LegacyHandoffError>()("HandoffError", {
  reason: Schema.Literals([
    "not_found",
    "expired",
    "conflict",
    "unavailable",
    "limit_reached",
    "invalid_request",
  ]),
}) {}

const encodeError = Schema.encodeSync(Schema.toCodecJson(HandoffError));
const decodeError = Schema.decodeUnknownSync(Schema.toCodecJson(HandoffError));
const decodeLegacy = Schema.decodeUnknownSync(Schema.toCodecJson(LegacyHandoffError));

describe("handoff errors across versions", () => {
  it("an approved change's outcome still decodes for an older client, and reaches a newer one", () => {
    const wire = JSON.parse(
      JSON.stringify(
        encodeError(
          new HandoffError({
            reason: "invalid_request",
            outcome: "apply_unknown",
            detail: "connection reset",
          }),
        ),
      ),
    );
    expect(decodeLegacy(wire).reason).toBe("invalid_request");
    const current = decodeError(wire);
    expect(current.message).toBe(
      "This change may have been applied (connection reset). Check the provider with Diagnose before you approve it again.",
    );
  });
});

it("roundtrips foreground request metadata through persisted handoff JSON without changing canonical fields", () => {
  const decode = Schema.decodeUnknownSync(HandoffJson);
  const encode = Schema.encodeSync(HandoffJson);
  const wire = {
    handoffId: "handoff:foreground",
    kind: "approval",
    title: "Allow desktop focus?",
    reason: "Check build",
    requestedBy: {
      threadId: "thread:one",
      providerInstanceId: "codex",
      path: "computer_use.grant",
    },
    target: { environmentId: "environment:one", path: "computer_use.grant" },
    dedupeKey: "foreground",
    state: "completed",
    expiresAt: "2026-10-25T01:30:00.000Z",
    createdAt: "2026-10-25T01:00:00.000Z",
    actor: { type: "client", label: "Person" },
    computerUseForeground: { purpose: "Check build", target: "desktop" },
  };
  expect(encode(decode(wire))).toEqual(wire);
  const { computerUseForeground: _metadata, ...legacy } = wire;
  expect(encode(decode(legacy))).toEqual(legacy);
  for (const computerUseForeground of [
    { purpose: " ", target: "desktop" },
    { purpose: "Check build", target: "window" },
  ])
    expect(() => decode({ ...wire, computerUseForeground })).toThrow();
});
