import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderDiagnoseInput,
  ProviderDiagnoseOnHostInput,
  ProviderDiagnoseOnHostResult,
  ProviderDiagnoseResult,
} from "./providerDiagnosis.ts";

const decodeInput = Schema.decodeUnknownSync(ProviderDiagnoseOnHostInput);
const decodeLocalInput = Schema.decodeUnknownSync(ProviderDiagnoseInput);
const decodeLocalResult = Schema.decodeUnknownSync(ProviderDiagnoseResult);
const resultCodec = Schema.toCodecJson(ProviderDiagnoseOnHostResult);
const decodeResult = Schema.decodeUnknownSync(resultCodec);
const encodeResult = Schema.encodeSync(resultCodec);

describe("provider diagnosis host wrappers", () => {
  it("preserves local requests and forwards remote cwd as request context", () => {
    const input = { instanceId: "codex", driver: "codex", cwd: "/remote/project" };
    expect(decodeInput(input)).toEqual(decodeLocalInput(input));
    const remote = decodeInput({ ...input, host: "vps-1" });
    expect(remote).toEqual({ ...input, host: "vps-1" });
    const { host, ...local } = remote;
    expect(host).toBe("vps-1");
    expect(decodeLocalInput(local)).toEqual(input);
  });

  it.each(["", "-option", "two hosts", "2001:db8::1", "a".repeat(65)])(
    "rejects invalid host %j in both wrappers",
    (host) => {
      expect(() => decodeInput({ host })).toThrow();
      expect(() => decodeResult({ checkedBy: "server", diagnoses: [], host })).toThrow();
    },
  );

  it("round-trips actual provider checks and preserves the existing checkedBy literals", () => {
    const local = decodeLocalResult({
      checkedBy: "server",
      diagnoses: [
        {
          instanceId: "codex",
          driver: "codex",
          configured: true,
          ready: false,
          checks: [
            {
              id: "auth",
              status: "fail",
              reason: "not_signed_in",
              summary: "Sign in on the SSH host.",
              fix: { actor: "human", instruction: "Sign in on the host.", handoff: "terminal" },
            },
          ],
        },
      ],
    });
    for (const result of [local, { ...local, host: "vps-1" }]) {
      expect(decodeResult(JSON.parse(JSON.stringify(encodeResult(result))))).toEqual(result);
    }
    expect(decodeResult({ checkedBy: "cli", diagnoses: [] })).toEqual({
      checkedBy: "cli",
      diagnoses: [],
    });
    expect(() => decodeResult({ checkedBy: "remote", diagnoses: [], host: "vps-1" })).toThrow();
  });
});
