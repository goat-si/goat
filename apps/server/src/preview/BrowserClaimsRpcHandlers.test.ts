import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

it.effect("allows only person sessions and requires settings to widen browser access", () =>
  Effect.gen(function* () {
    const person = sessionResolver({ subject: "paired-person" });
    const mcp = sessionResolver({ subject: "mcp-client" });
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
