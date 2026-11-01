import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  captureRpcMemoryGrantCeiling,
  rejectPublicMemoryGrantCeiling,
} from "../auth/RpcAuthorization.ts";
import { captureMcpTaskMemoryGrantCeiling } from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const scope = (grantedScopes?: ReadonlyArray<AuthEnvironmentScope>): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:memory-capture"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "memory-capture",
  thread: undefined,
  client: { sessionId: "test-session", label: "test caller", access: "full-access" },
  ...(grantedScopes === undefined ? {} : { grantedScopes }),
  reauthorize: () => Effect.void,
});

it.effect("captures external OAuth and managed session memory grants independently of modes", () =>
  Effect.gen(function* () {
    for (const [scopes, expected] of [
      [[], "none"],
      [["memory:write"], "none"],
      [["memory:read"], "read"],
      [["memory:read", "memory:write"], "read_write"],
    ] as const) {
      const external = scope(scopes);
      assert.strictEqual(yield* captureMcpTaskMemoryGrantCeiling(external, false), expected);
      const managed = {
        ...external,
        client: undefined,
        thread: {
          threadId: ThreadId.make("thread:memory-capture"),
          providerSessionId: "provider-session:test",
          providerInstanceId: ProviderInstanceId.make("provider-test"),
        },
      };
      assert.strictEqual(yield* captureMcpTaskMemoryGrantCeiling(managed, false), expected);
    }
    assert.strictEqual(yield* captureMcpTaskMemoryGrantCeiling(scope(), false), "none");
    const { reauthorize: _reauthorize, ...withoutReauthorize } = scope(["memory:read"]);
    assert.strictEqual(yield* captureMcpTaskMemoryGrantCeiling(withoutReauthorize, false), "none");
    assert.strictEqual(
      yield* captureMcpTaskMemoryGrantCeiling(scope(["memory:read", "memory:write"]), true),
      "read",
    );
    assert.strictEqual(
      yield* captureMcpTaskMemoryGrantCeiling(
        {
          ...scope(["memory:read", "memory:write"]),
          client: { sessionId: "readonly", label: "test", access: "read-only" },
        },
        false,
      ),
      "read",
    );
  }),
);

it.effect("RPC capture reauthorizes every call and recaptures lower and restored scopes", () =>
  Effect.gen(function* () {
    let revoked = false;
    const checked: ReadonlyArray<AuthEnvironmentScope>[] = [];
    const input = {
      grantedScopes: ["memory:read", "memory:write"] as const,
      readOnly: false,
      reauthorize: (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
        Effect.gen(function* () {
          checked.push(scopes);
          if (revoked)
            return yield* new EnvironmentAuthorizationError({
              message: "synthetic revoked session",
              requiredScope: "memory:read",
            });
        }),
    };
    assert.strictEqual(yield* captureRpcMemoryGrantCeiling(input), "read_write");
    assert.strictEqual(
      yield* captureRpcMemoryGrantCeiling({ ...input, grantedScopes: [] }),
      "none",
    );
    assert.strictEqual(
      yield* captureRpcMemoryGrantCeiling({ ...input, grantedScopes: ["memory:read"] }),
      "read",
    );
    assert.strictEqual(yield* captureRpcMemoryGrantCeiling(input), "read_write");
    assert.deepStrictEqual(checked, [
      ["memory:read", "memory:write"],
      [],
      ["memory:read"],
      ["memory:read", "memory:write"],
    ]);
    revoked = true;
    const failure = yield* captureRpcMemoryGrantCeiling(input).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "EnvironmentAuthorizationError");
  }),
);

it.effect("rejects client-forged task memory ceilings before dispatch", () =>
  Effect.gen(function* () {
    for (const memoryGrantCeiling of ["read", "read_write"]) {
      assert.strictEqual(
        (yield* rejectPublicMemoryGrantCeiling({ memoryGrantCeiling }).pipe(Effect.result))._tag,
        "Failure",
      );
    }
    yield* rejectPublicMemoryGrantCeiling({});
  }),
);
