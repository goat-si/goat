import { EnvironmentId, type AuthEnvironmentScope } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { admitRemoteMemoryGrantCeiling } from "./ThreadLaunchMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const scope = (
  grantedScopes: ReadonlyArray<AuthEnvironmentScope>,
  readOnly = false,
): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:memory-admission"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "memory-admission",
  thread: undefined,
  client: {
    sessionId: "fixture-session",
    label: "dispatch",
    access: readOnly ? "read-only" : "full-access",
  },
  grantedScopes,
  reauthorize: () => Effect.void,
});
const policy = { policyReady: true, enableAgentMemoryAccess: true, epoch: 1 };

it.effect(
  "admits only authenticated task ceilings and applies destination policy and read-only",
  () =>
    Effect.gen(function* () {
      for (const ceiling of ["none", "read", "read_write"] as const) {
        expect(
          yield* admitRemoteMemoryGrantCeiling(
            scope(["memory:read", "memory:write"]),
            ceiling,
            policy,
          ),
        ).toBe(ceiling);
        expect(
          yield* admitRemoteMemoryGrantCeiling(scope(["memory:read", "memory:write"]), ceiling, {
            ...policy,
            enableAgentMemoryAccess: false,
          }),
        ).toBe("none");
      }
      expect(
        yield* admitRemoteMemoryGrantCeiling(
          scope(["memory:read", "memory:write"], true),
          "read_write",
          policy,
        ),
      ).toBe("read");
      for (const ceiling of ["read", "read_write"] as const) {
        const forged = yield* admitRemoteMemoryGrantCeiling(scope([]), ceiling, policy).pipe(
          Effect.result,
        );
        expect(forged._tag).toBe("Failure");
      }
      const writeForgery = yield* admitRemoteMemoryGrantCeiling(
        scope(["memory:read"]),
        "read_write",
        policy,
      ).pipe(Effect.result);
      expect(writeForgery._tag).toBe("Failure");
      const { reauthorize: _reauthorize, ...legacy } = scope(["memory:read", "memory:write"]);
      expect(
        (yield* admitRemoteMemoryGrantCeiling(legacy, "read", policy).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
);
