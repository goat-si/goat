import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderHomeRequestInput, ProviderHomeRequestResultJson } from "./providerHomeRequest.ts";

const inputCodec = Schema.toCodecJson(ProviderHomeRequestInput);
// Excess-property handling is a decoder option, not a schema annotation.
const decodeInput = Schema.decodeUnknownSync(inputCodec, { onExcessProperty: "error" });
const decodeRawInput = Schema.decodeUnknownSync(ProviderHomeRequestInput, {
  onExcessProperty: "error",
});
const encodeInput = Schema.encodeSync(inputCodec);
const decodeResult = Schema.decodeUnknownSync(ProviderHomeRequestResultJson);
const encodeResult = Schema.encodeSync(ProviderHomeRequestResultJson);

const approval = {
  kind: "needs_human",
  handoff: {
    handoffId: "home-request-1",
    kind: "approval",
    title: "Use OpenCodex Home",
    state: "pending",
    expiresAt: "2026-10-18T00:15:00.000Z",
    targetPath: "provider.home_request",
  },
  next: { after: "approval", call: "goat_provider_diagnose" },
};

describe("OpenCodex Home approval request codecs", () => {
  it.effect("round-trips connect and disconnect inputs without granting approval", () =>
    Effect.sync(() => {
      for (const action of ["connect", "disconnect"]) {
        const input = { instanceId: "codex_home", action };
        const decoded = decodeInput(input);
        expect(decodeInput(JSON.parse(JSON.stringify(encodeInput(decoded))))).toEqual(input);
      }
      const input = {
        instanceId: "codex_home",
        action: "connect",
        opencodexBaseUrl: "http://127.0.0.1:10101/v1",
      };
      expect(decodeInput(input)).toEqual(input);
    }),
  );

  it.effect("rejects approval flags credentials arbitrary patches and host routing", () =>
    Effect.sync(() => {
      for (const extra of [
        { sessionId: "client-session" },
        { confirm: true },
        { credential: "not-a-real-credential" },
        { config: { modelRoute: "opencodex" } },
        { host: "vps-1" },
        { expectedFingerprint: "server-private" },
        { expectedRevision: "server-private" },
      ]) {
        const input = { instanceId: "codex_home", action: "connect", ...extra };
        expect(() => decodeInput(input)).toThrow();
        expect(() => decodeRawInput(input)).toThrow();
      }
      expect(() => decodeInput({ action: "connect" })).toThrow();
      expect(() => decodeInput({ instanceId: "codex_home", action: "approve" })).toThrow();
    }),
  );

  it.effect("round-trips a needs_human handoff as JSON with its approval expiry", () =>
    Effect.sync(() => {
      const result = decodeResult(approval);
      expect(result.kind).toBe("needs_human");
      if (result.kind !== "needs_human") throw new Error("Expected a human approval request.");
      expect(DateTime.isDateTime(result.handoff.expiresAt)).toBe(true);
      expect(JSON.parse(JSON.stringify(encodeResult(result)))).toEqual(approval);
      expect(decodeResult(JSON.parse(JSON.stringify(encodeResult(result))))).toEqual(result);
    }),
  );

  it.effect("does not expose private approval context in its public result", () =>
    Effect.sync(() => {
      const result = decodeResult({
        ...approval,
        approvedBySessionId: "client-session",
        expectedFingerprint: "server-private",
        handoff: { ...approval.handoff, expectedRevision: "server-private" },
      });
      expect(JSON.parse(JSON.stringify(encodeResult(result)))).toEqual(approval);
    }),
  );

  it.effect("round-trips an error with an optional human fix", () =>
    Effect.sync(() => {
      for (const error of [
        {
          kind: "error",
          code: "unsupported",
          message: "Ask again in a thread on the target environment.",
        },
        {
          kind: "error",
          code: "provider_instance_busy",
          message: "End the instance's active sessions.",
          fix: {
            actor: "human",
            instruction: "End active sessions and ask again.",
            handoff: "approval",
          },
        },
      ]) {
        expect(JSON.parse(JSON.stringify(encodeResult(decodeResult(error))))).toEqual(error);
      }
    }),
  );

  it.effect("rejects a false success or a non-approval continuation", () =>
    Effect.sync(() => {
      expect(() => decodeResult({ kind: "ok" })).toThrow();
      expect(() =>
        decodeResult({
          ...approval,
          next: { after: "terminal", call: "goat_provider_diagnose" },
        }),
      ).toThrow();
      expect(() =>
        decodeResult({
          ...approval,
          next: { after: "approval", call: "goat_provider_home_request" },
        }),
      ).toThrow();
    }),
  );
});
