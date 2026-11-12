import { expect, it, vi } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthHubProxyScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  WS_METHODS,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import { authorizeRpcCall } from "./RpcAuthorization.ts";
import { make } from "./AccessRpc.ts";

it.effect("requires access write on the server for every access mutation", () =>
  Effect.gen(function* () {
    for (const method of [
      WS_METHODS.authAccessCreatePairing,
      WS_METHODS.authAccessRevokePairing,
      WS_METHODS.authAccessRevokeClient,
    ]) {
      const denied = yield* Effect.flip(authorizeRpcCall([AuthOrchestrationReadScope], method, {}));
      expect(denied.requiredPermission).toBe(AuthAccessWriteScope);
      yield* authorizeRpcCall([AuthAccessWriteScope], method, {});
    }
  }),
);

it.effect("does not delegate unheld permissions or allow a paired client to grant hub access", () =>
  Effect.gen(function* () {
    const issue = vi.fn(() =>
      Effect.succeed({
        id: "link",
        credential: "test-code",
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
      }),
    );
    const session: EnvironmentAuth.AuthenticatedSession = {
      sessionId: AuthSessionId.make("current"),
      subject: "one-time-token",
      method: "bearer-access-token",
      scopes: [AuthAccessWriteScope, AuthOrchestrationReadScope],
      principalKind: "person",
    };
    const rpc = yield* make(session).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, {
        issuePairingCredential: issue,
      } as never),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({ hub: { enabled: true } }),
      } as never),
    );
    const denied = yield* Effect.flip(
      rpc[WS_METHODS.authAccessCreatePairing]({ scopes: ["settings:write"] }),
    );
    expect(denied._tag).toBe("EnvironmentAuthorizationError");
    const hubDenied = yield* Effect.flip(
      rpc[WS_METHODS.authAccessCreatePairing]({ scopes: [AuthHubProxyScope] }),
    );
    expect(hubDenied._tag).toBe("EnvironmentAuthorizationError");
    expect(issue).not.toHaveBeenCalled();
    yield* rpc[WS_METHODS.authAccessCreatePairing]({ scopes: [AuthOrchestrationReadScope] });
    expect(issue).toHaveBeenCalledTimes(1);
  }),
);

it.effect("uses the authenticated client as the revocation owner", () =>
  Effect.gen(function* () {
    const revoke = vi.fn((current: AuthSessionId, target: AuthSessionId) =>
      current === target
        ? Effect.fail(new EnvironmentAuth.ServerAuthForbiddenOperationError())
        : Effect.succeed(true),
    );
    const current = AuthSessionId.make("current");
    const session: EnvironmentAuth.AuthenticatedSession = {
      sessionId: current,
      subject: "one-time-token",
      method: "bearer-access-token",
      scopes: [AuthAccessWriteScope],
      principalKind: "person",
    };
    const rpc = yield* make(session).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, {
        revokeClientSession: revoke,
      } as never),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({ hub: { enabled: false } }),
      } as never),
    );
    const target = AuthSessionId.make("other");
    expect(yield* rpc[WS_METHODS.authAccessRevokeClient]({ sessionId: target })).toEqual({
      revoked: true,
    });
    expect(revoke).toHaveBeenCalledWith(current, target);
    const refused = yield* Effect.flip(
      rpc[WS_METHODS.authAccessRevokeClient]({ sessionId: current }),
    );
    expect(refused.message).toBe("Cannot revoke the current client.");
  }),
);

it.effect("preserves the existing owner and enabled-hub requirements for hub delegation", () =>
  Effect.gen(function* () {
    let enabled = false;
    const issue = vi.fn(() =>
      Effect.succeed({
        id: "link",
        credential: "test-code",
        expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
      }),
    );
    const session: EnvironmentAuth.AuthenticatedSession = {
      sessionId: AuthSessionId.make("owner"),
      subject: "administrative-bootstrap",
      method: "bearer-access-token",
      scopes: [AuthAccessWriteScope, "environment:maintain"],
      principalKind: "person",
    };
    const rpc = yield* make(session).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, {
        issuePairingCredential: issue,
      } as never),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.sync(() => ({ hub: { enabled } })),
      } as never),
    );
    const denied = yield* Effect.flip(
      rpc[WS_METHODS.authAccessCreatePairing]({ scopes: [AuthHubProxyScope] }),
    );
    expect(denied._tag).toBe("AuthAccessMutationError");
    expect(issue).not.toHaveBeenCalled();
    enabled = true;
    yield* rpc[WS_METHODS.authAccessCreatePairing]({ scopes: [AuthHubProxyScope] });
    expect(issue).toHaveBeenCalledTimes(1);
  }),
);
