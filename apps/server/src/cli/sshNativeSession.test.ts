// @effect-diagnostics globalDate:off - fixture expiries are ISO strings the endpoint returns.
import {
  AuthSessionId,
  EnvironmentId,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_SESSION_PATH,
  makeChildSetupPurpose,
  type RuntimeSessionRequest,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { requestNativeRuntimeCredential } from "./sshNativeSession.ts";

const now = 1_800_000_000_000;
const origin = "http://127.0.0.1:43123";
const secret = "c".repeat(64);
const sessionId = AuthSessionId.make("native-session-1");
const purpose = makeChildSetupPurpose(
  {
    purpose: "opencodex-child-setup",
    homeEnvironmentId: EnvironmentId.make("synthetic-home"),
    destinationEnvironmentId: EnvironmentId.make("synthetic-child"),
    operationId: "operation-1",
    grantId: "grant-1",
    grantRevision: 4,
  },
  "installOpenCodex",
  "phase-1",
  now,
);
const request: RuntimeSessionRequest = {
  kind: "session",
  subject: "mcp-client",
  scopes: ["orchestration:read"],
  ttl: "30s",
  childSetupPurpose: purpose,
};
const issued = {
  sessionId,
  token: "fixture-bearer",
  method: "bearer-access-token",
  subject: "mcp-client",
  scopes: ["orchestration:read"],
  expiresAt: new Date(now + 30_000).toISOString(),
  childSetupPurpose: purpose,
};

describe("native Windows runtime credentials", () => {
  it("returns the issuer session id and bounded purpose to Home with the issued bearer", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(now);
    using posted = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(issued));
    expect(await requestNativeRuntimeCredential(origin, secret, request)).toEqual(issued);
    const [url, init] = posted.mock.calls[0] ?? [];
    expect(url).toBe(origin + GOAT_RUNTIME_SESSION_PATH);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(new Headers(init?.headers).get(GOAT_RUNTIME_CONTROL_HEADER)).toBe(secret);
  });

  it.each([
    ["no issuer session id", { ...issued, sessionId: undefined }],
    ["a dropped setup purpose", { ...issued, childSetupPurpose: undefined }],
    ["a broader scope", { ...issued, scopes: ["orchestration:read", "orchestration:operate"] }],
    [
      "an expiry past the purpose",
      { ...issued, expiresAt: new Date(purpose.expiresAt + 1).toISOString() },
    ],
  ])("refuses an issued session with %s", async (_, reply) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(now);
    using _posted = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(reply));
    await expect(requestNativeRuntimeCredential(origin, secret, request)).rejects.toThrow();
  });

  it.each([true, false])(
    "posts a revocation and accepts only its same-id acknowledgement, revoked=%s",
    async (revoked) => {
      const acknowledgement = { sessionId, revoked };
      using posted = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json(acknowledgement));
      expect(
        await requestNativeRuntimeCredential(origin, secret, { kind: "revoke", sessionId }),
      ).toEqual(acknowledgement);
      expect(JSON.parse(String(posted.mock.calls[0]?.[1]?.body))).toEqual({
        kind: "revoke",
        sessionId,
      });
    },
  );

  it.each([{ sessionId: "other-session", revoked: true }, { revoked: true }, { sessionId }])(
    "refuses a missing or mismatched revocation acknowledgement: %j",
    async (reply) => {
      using posted = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(reply));
      await expect(
        requestNativeRuntimeCredential(origin, secret, { kind: "revoke", sessionId }),
      ).rejects.toThrow();
      expect(posted).toHaveBeenCalledTimes(1);
    },
  );

  it("pairing still requires its credential", async () => {
    using _empty = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ credential: " " }))
      .mockResolvedValueOnce(Response.json({ credential: "fixture-pairing" }));
    await expect(
      requestNativeRuntimeCredential(origin, secret, { kind: "pairing" }),
    ).rejects.toThrow("Empty pairing credential.");
    expect(await requestNativeRuntimeCredential(origin, secret, { kind: "pairing" })).toEqual({
      credential: "fixture-pairing",
    });
  });

  it("does not retry after the runtime endpoint refuses", async () => {
    using posted = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ message: "refused" }, { status: 403 }));
    await expect(
      requestNativeRuntimeCredential(origin, secret, { kind: "revoke", sessionId }),
    ).rejects.toThrow("Runtime control refused.");
    expect(posted).toHaveBeenCalledTimes(1);
  });
});
