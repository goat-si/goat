import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Local from "./ProviderDiagnosisService.ts";
import * as Routing from "./ProviderDiagnosisRouting.ts";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "test", label: "test", access: "read-only" },
  grantedScopes: ["orchestration:read"],
  reauthorize: () => Effect.void,
};
it.effect(
  "diagnoses locally only when host is omitted; remote calls are ready-only and drop host",
  () =>
    Effect.gen(function* () {
      let locals = 0;
      let remotes = 0;
      const result = { checkedBy: "server" as const, diagnoses: [] };
      const service = yield* Routing.ProviderDiagnosisRouting.pipe(
        Effect.provide(
          Routing.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(SessionStore.SessionStore)({
                  cookieName: "test",
                  legacyCookieName: undefined,
                }),
                Layer.mock(Local.ProviderDiagnosisService)({
                  diagnose: (input) =>
                    Effect.sync(() => {
                      locals++;
                      expect(input).toEqual({ cwd: "/remote/repo" });
                      return result;
                    }),
                }),
                Layer.mock(Dispatch.SshRemoteDispatch)({}),
                Layer.mock(Hosts.HostThreadsMcpService)({
                  readOnHost: (_caller, input, decode) =>
                    Effect.gen(function* () {
                      remotes++;
                      expect(_caller).toBe(scope);
                      expect(input.requireReady).toBe(true);
                      expect(input.arguments).toEqual({ cwd: "/remote/repo" });
                      const decoded = yield* decode(result).pipe(
                        Effect.mapError(
                          () =>
                            new OrchestratorMcpFailure({
                              code: "orchestration_error",
                              message: "decode",
                            }),
                        ),
                      );
                      return { ...decoded, host: input.host };
                    }),
                }),
              ),
            ),
          ),
        ),
      );
      expect(yield* service.diagnose({ cwd: "/remote/repo" }, { kind: "mcp", scope })).toEqual(
        result,
      );
      expect(
        yield* service.diagnose({ host: "box", cwd: "/remote/repo" }, { kind: "mcp", scope }),
      ).toEqual({ ...result, host: "box" });
      expect([locals, remotes]).toEqual([1, 1]);
    }),
);
it.effect("a stopped remote is a typed error, with no local fallback", () =>
  Effect.gen(function* () {
    let locals = 0;
    const service = yield* Routing.ProviderDiagnosisRouting.pipe(
      Effect.provide(
        Routing.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "test",
                legacyCookieName: undefined,
              }),
              Layer.mock(Local.ProviderDiagnosisService)({
                diagnose: () => {
                  locals++;
                  return Effect.succeed({ checkedBy: "server", diagnoses: [] });
                },
              }),
              Layer.mock(Dispatch.SshRemoteDispatch)({}),
              Layer.mock(Hosts.HostThreadsMcpService)({
                readOnHost: () =>
                  Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message:
                        "Call goat_ssh_host_prepare for box, then call goat_ssh_host_status until setup completes; retry goat_provider_diagnose.",
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
    const failure = yield* service
      .diagnose({ host: "box" }, { kind: "mcp", scope })
      .pipe(Effect.flip);
    expect(failure.message).toContain("goat_ssh_host_prepare");
    expect(locals).toBe(0);
  }),
);
it.effect.each(["client", "mcp"] as const)(
  "rejects revoked %s authority before either diagnosis",
  (kind) =>
    Effect.gen(function* () {
      let calls = 0;
      const service = yield* Routing.ProviderDiagnosisRouting.pipe(
        Effect.provide(
          Routing.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(SessionStore.SessionStore)({
                  cookieName: "test",
                  legacyCookieName: undefined,
                  listActive: () => Effect.succeed([]),
                }),
                Layer.mock(Local.ProviderDiagnosisService)({
                  diagnose: () => {
                    calls++;
                    return Effect.succeed({ checkedBy: "server", diagnoses: [] });
                  },
                }),
                Layer.mock(Dispatch.SshRemoteDispatch)({}),
                Layer.mock(Hosts.HostThreadsMcpService)({}),
              ),
            ),
          ),
        ),
      );
      const failure = yield* service
        .diagnose(
          {},
          kind === "client"
            ? { kind, sessionId: AuthSessionId.make("revoked") }
            : {
                kind,
                scope: {
                  ...scope,
                  reauthorize: () =>
                    Effect.fail(
                      new EnvironmentAuthorizationError({
                        requiredScope: "orchestration:read",
                        message: "revoked",
                      }),
                    ),
                },
              },
        )
        .pipe(Effect.flip);
      expect(failure._tag).toBe("EnvironmentAuthorizationError");
      expect(calls).toBe(0);
    }),
);
