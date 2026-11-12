import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  WS_METHODS,
} from "@goat/contracts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { sessionResolver } from "../handoffs/HumanStepAuthority.ts";
import * as BrowserRpc from "./BrowserClaimsRpcHandlers.ts";

it.effect("browser window listing is person-only and unavailable without the driver", () =>
  Effect.gen(function* () {
    for (const principalKind of ["outside_client", "person"] as const) {
      const handlers = BrowserRpc.makeBrowserClaimsRpcHandlers(Option.none(), { principalKind });
      const result = yield* handlers[WS_METHODS.browserClaimsWindows]().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure._tag).toBe(
          principalKind === "outside_client"
            ? "EnvironmentAuthorizationError"
            : "BrowserClaimsRpcError",
        );
    }
  }),
);

it.effect("refuses browser claim subscriptions from non-person sessions", () =>
  Effect.gen(function* () {
    const handlers = BrowserRpc.makeBrowserClaimsRpcHandlers(Option.none(), {
      principalKind: "outside_client",
    });
    const result = yield* handlers[WS_METHODS.browserClaimsSubscribe]().pipe(
      Stream.runCollect,
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("EnvironmentAuthorizationError");
  }),
);

it.effect("allows only person sessions and requires settings to widen browser access", () =>
  Effect.gen(function* () {
    const person = sessionResolver({ principalKind: "person" });
    const mcp = sessionResolver({ principalKind: "outside_client" });
    yield* BrowserRpc.requirePerson(person);
    expect((yield* BrowserRpc.requirePerson(mcp).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* BrowserRpc.requirePerson({ kind: "thread" }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    const base = [AuthOrchestrationOperateScope];
    expect(
      (yield* RpcAuthorization.authorizeRpcCall(base, WS_METHODS.browserClaimsClaim, {}).pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* RpcAuthorization.authorizeRpcCall(base, WS_METHODS.browserClaimsAnswer, {
        claimId: "claim:1",
        approved: true,
      }).pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* RpcAuthorization.authorizeRpcCall(
      [...base, AuthSettingsWriteScope],
      WS_METHODS.browserClaimsAnswer,
      { claimId: "claim:1", approved: true },
    );
    yield* RpcAuthorization.authorizeRpcCall(base, WS_METHODS.browserClaimsAnswer, {
      claimId: "claim:1",
      approved: false,
    });
    yield* RpcAuthorization.authorizeRpcCall(base, WS_METHODS.browserClaimsRevoke, {});
    yield* RpcAuthorization.authorizeRpcCall(base, WS_METHODS.browserClaimsEnd, {});
    for (const method of [
      WS_METHODS.browserClaimsClaim,
      WS_METHODS.browserClaimsAnswer,
      WS_METHODS.browserClaimsRevoke,
      WS_METHODS.browserClaimsEnd,
      WS_METHODS.browserClaimsList,
    ]) {
      yield* RpcAuthorization.authorizeRpcCall(AuthStandardClientScopes, method, {
        claimId: "claim:1",
        approved: true,
      });
      const refused = yield* RpcAuthorization.authorizeRpcCall(
        [...base, AuthSettingsWriteScope, AuthOrchestrationApproveScope],
        method,
        { claimId: "claim:1", approved: true },
      ).pipe(Effect.andThen(BrowserRpc.requirePerson(mcp)), Effect.result);
      expect(refused._tag).toBe("Failure");
    }
  }),
);
