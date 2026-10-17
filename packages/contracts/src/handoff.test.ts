import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HandoffHuman, HandoffSummary } from "./handoff.ts";

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
