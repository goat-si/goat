import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HandoffError, HandoffHuman, HandoffSummary } from "./handoff.ts";

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
