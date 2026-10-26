import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthMcpApprovalDecision,
  AuthMcpApprovalDetails,
  AuthEnvironmentScopes,
  AuthEnvironmentScope,
  AuthHubProxyScope,
  authScopeRequiredResponse,
  AuthGrantScopes,
  AuthStandardClientScopes,
  authScopeResponse,
  AuthSessionState,
  sessionGrantsScope,
} from "./auth.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    const decodeAuthEnvironmentScopes = Schema.decodeSync(AuthEnvironmentScopes);

    expect(decodeAuthEnvironmentScopes(["review:write"])).toEqual(["review:write"]);
    const decodeAuthGrantScopes = Schema.decodeUnknownSync(AuthGrantScopes);

    expect(() => decodeAuthGrantScopes(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  // Keep the pre-granular vocabulary frozen to expose compatibility regressions.
  const oldScopes = Schema.Array(
    Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
    ]),
  );

  const decodeOldScopes = Schema.decodeUnknownSync(oldScopes);

  // hub:proxy is only ever required under /hub/nodes, which clients older than it never request.
  it.each(
    AuthEnvironmentScope.literals.filter(
      (scope) => !scope.startsWith("memory:") && scope !== AuthHubProxyScope,
    ),
  )("keeps %s permission errors decodable by old clients", (scope) => {
    const response = authScopeRequiredResponse(scope);
    expect(decodeOldScopes([response.requiredScope])).toEqual([response.requiredScope]);
    expect(response.requiredPermission).toBe(scope);
  });

  it("keeps old clients able to decode grants with new permissions", () => {
    const response = authScopeResponse(AuthStandardClientScopes);
    expect(decodeOldScopes(response.scopes)).toEqual(response.scopes);
    expect(response.permissions).toEqual(AuthStandardClientScopes);
    expect(response.scopes).not.toContain("filesystem:read");
  });

  it("ignores unknown response permissions without falling back to broader scopes", () => {
    const decodeAuthSessionState = Schema.decodeUnknownSync(AuthSessionState);

    const session = decodeAuthSessionState({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: ["orchestration:operate"],
      permissions: ["future:permission"],
    });
    expect(session.permissions).toEqual([]);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(false);
    expect(sessionGrantsScope(session, "settings:write")).toBe(false);
  });

  it.each([
    {
      label: "exact permissions over the legacy presentation",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["filesystem:read"],
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "a permission absent from the legacy presentation",
      session: { authenticated: true, scopes: [], permissions: ["filesystem:read"] },
      scope: "filesystem:read",
      expected: true,
    },

    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});

describe("memory permissions", () => {
  it("recognizes memory scopes without legacy parent expansion", () => {
    for (const scope of ["memory:read", "memory:write", "memory:sync"] as const) {
      expect(Schema.decodeSync(AuthEnvironmentScope)(scope)).toBe(scope);
      expect(
        sessionGrantsScope(
          { authenticated: true, scopes: ["orchestration:operate", "orchestration:read"] },
          scope,
        ),
      ).toBe(false);
    }
  });
  it("denies memory to unauthenticated and explicit empty grants", () => {
    expect(
      sessionGrantsScope({ authenticated: false, permissions: ["memory:read"] }, "memory:read"),
    ).toBe(false);
    expect(
      sessionGrantsScope(
        { authenticated: true, scopes: ["memory:read"], permissions: [] },
        "memory:read",
      ),
    ).toBe(false);
  });
  it("keeps memory out of legacy scope response", () => {
    expect(authScopeResponse(["memory:read", "memory:write", "memory:sync"])).toEqual({
      scopes: [],
      permissions: ["memory:read", "memory:write", "memory:sync"],
    });
  });
  it("includes read and write but excludes sync in default client grants", () => {
    expect(AuthStandardClientScopes).toContain("memory:read");
    expect(AuthStandardClientScopes).toContain("memory:write");
    expect(AuthStandardClientScopes).not.toContain("memory:sync");
  });
  it("does not upgrade stored old grants", () => {
    const stored = Schema.decodeSync(AuthGrantScopes)(["orchestration:operate"]);
    expect(stored).toEqual(["orchestration:operate"]);
    expect(sessionGrantsScope({ authenticated: true, permissions: stored }, "memory:write")).toBe(
      false,
    );
  });
  it("requires explicit memory consent on both approval arms", () => {
    for (const decision of [
      { _tag: "pairing-code", access: "full-access", code: "synthetic" },
      { _tag: "browser-session", access: "full-access", csrfToken: "synthetic" },
    ]) {
      const decode = Schema.decodeUnknownSync(AuthMcpApprovalDecision, {
        onExcessProperty: "error",
      });
      expect(decode(decision)).not.toHaveProperty("memoryScopes");
      expect(decode({ ...decision, memoryScopes: ["memory:read", "memory:write"] })).toHaveProperty(
        "memoryScopes",
        ["memory:read", "memory:write"],
      );
      expect(() => decode({ ...decision, memoryScopes: ["memory:sync"] })).toThrow();
      expect(() => decode({ ...decision, memoryScopes: ["memory:read", "memory:read"] })).toThrow();
    }
  });
});
it("old approval omission grants no memory", () => {
  const decision = Schema.decodeUnknownSync(AuthMcpApprovalDecision)({
    _tag: "pairing-code",
    access: "full-access",
    code: "synthetic",
  });
  expect(decision).not.toHaveProperty("memoryScopes");
  expect(
    sessionGrantsScope({ authenticated: true, scopes: ["orchestration:operate"] }, "memory:write"),
  ).toBe(false);
});
it("both approval arms round trip explicit read write selection", () => {
  for (const proof of [
    { _tag: "pairing-code", code: "synthetic" },
    { _tag: "browser-session", csrfToken: "synthetic" },
  ])
    expect(
      Schema.decodeUnknownSync(AuthMcpApprovalDecision)({
        ...proof,
        access: "full-access",
        memoryScopes: ["memory:read", "memory:write"],
      }),
    ).toHaveProperty("memoryScopes", ["memory:read", "memory:write"]);
});
it("rejects sync duplicate and unknown memory grants", () => {
  for (const memoryScopes of [["memory:sync"], ["memory:read", "memory:read"], ["memory:unknown"]])
    expect(() =>
      Schema.decodeUnknownSync(AuthMcpApprovalDecision)({
        _tag: "browser-session",
        access: "auto",
        csrfToken: "synthetic",
        memoryScopes,
      }),
    ).toThrow();
});
it("one click advertised scopes grant nothing by themselves", () => {
  const details = Schema.decodeUnknownSync(AuthMcpApprovalDetails)({
    clientName: "Synthetic",
    redirectHost: "localhost",
    environmentHost: "env",
    oneClickMemoryScopes: ["memory:read"],
  });
  expect(details.oneClickMemoryScopes).toEqual(["memory:read"]);
  expect(sessionGrantsScope({ authenticated: true, permissions: [] }, "memory:read")).toBe(false);
  expect(
    sessionGrantsScope(
      { authenticated: true, permissions: ["orchestration:operate"] },
      "memory:write",
    ),
  ).toBe(false);
});
