import {
  EnvironmentId,
  MemoryId,
  MemoryOperationId,
  MemoryRpcError,
  MemorySpaceId,
  type ServerConfig,
  WS_METHODS,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isHubMachinesUnsupportedError, isHubNodesUnsupportedError } from "../hubNodes.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type * as RpcSession from "./session.ts";
import { EnvironmentRpcUnavailableError, requestGuarded, RpcPermissionGuard } from "./client.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("older-hub"),
  label: "Older hub",
  httpBaseUrl: "https://hub.example.test",
  wsBaseUrl: "wss://hub.example.test",
});

const supervisorFor = Effect.fn("TestOlderHub.supervisor")(function* (
  client: WsRpcProtocolClient,
  config?: ServerConfig,
) {
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: config ? Effect.succeed(config) : Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.make(0).pipe(Effect.asVoid),
  });
});

describe("environment RPC against an older hub", () => {
  it.effect(
    "a hub without disposable machines answers hub.machines.* as unavailable, not a defect",
    () =>
      Effect.gen(function* () {
        const client = {
          [WS_METHODS.hubMachinesList]: () => Effect.die("Unknown request tag: hub.machines.list"),
        } as unknown as WsRpcProtocolClient;
        const result = yield* requestGuarded(WS_METHODS.hubMachinesList, {}).pipe(
          Effect.provideService(
            EnvironmentSupervisor.EnvironmentSupervisor,
            yield* supervisorFor(client),
          ),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          Effect.exit,
        );
        expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(false);
        const failure = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined;
        expect(failure).toBeInstanceOf(EnvironmentRpcUnavailableError);
        expect(isHubMachinesUnsupportedError(failure)).toBe(true);
        expect(isHubNodesUnsupportedError(failure)).toBe(false);
      }),
  );
  it.effect.each([false, true])(
    "negotiates mutation failures on the destination: %s",
    (supported) =>
      Effect.gen(function* () {
        const memorySpaceId = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
        const memoryId = MemoryId.make("00000000-0000-4000-8000-000000000002");
        const wire: unknown[] = [];
        const fail = (input: { readonly includeFailureDetails?: true }) => {
          wire.push(input);
          return Effect.fail(
            new MemoryRpcError({
              code: input.includeFailureDetails ? "thread_lineage_incomplete" : "invalid_output",
            }),
          );
        };
        const client = {
          [WS_METHODS.memoryUpsert]: fail,
          [WS_METHODS.memoryForget]: fail,
        } as unknown as WsRpcProtocolClient;
        const supervisor = yield* supervisorFor(client, {
          environment: {
            capabilities: {
              memory: {
                protocolVersion: 1,
                ...(supported ? { mutationFailureDetails: true } : {}),
              },
            },
          },
        } as ServerConfig);
        const base = {
          memorySpaceId,
          memoryId,
          expectedHeads: [],
          operationId: MemoryOperationId.make("00000000-0000-4000-8000-000000000003"),
        };
        const upsert = {
          ...base,
          baseBoundary: null,
          scope: { kind: "user" as const },
          assertionKind: "inference" as const,
          payload: { text: "synthetic", evidence: [], derivedFromMemoryRevisions: [] },
        };
        const provide = Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisor,
        );
        const permit = Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void });
        const upsertError = yield* requestGuarded(WS_METHODS.memoryUpsert, upsert).pipe(
          provide,
          permit,
          Effect.flip,
        );
        const forgetError = yield* requestGuarded(WS_METHODS.memoryForget, {
          ...base,
          includeFailureDetails: true,
        }).pipe(provide, permit, Effect.flip);
        const hint = supported ? { includeFailureDetails: true } : {};
        expect(wire).toEqual([
          { ...upsert, ...hint },
          { ...base, ...hint },
        ]);
        for (const error of [upsertError, forgetError])
          expect(error).toMatchObject({
            _tag: "MemoryRpcError",
            code: supported ? "thread_lineage_incomplete" : "invalid_output",
          });
      }),
  );
  it.effect.each([false, true])(
    "negotiates scope move and read fields on the destination: %s",
    (supported) =>
      Effect.gen(function* () {
        const memorySpaceId = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
        const memoryId = MemoryId.make("00000000-0000-4000-8000-000000000002");
        const wire: unknown[] = [];
        const receive = (input: unknown) => {
          wire.push(input);
          return Effect.void;
        };
        const client = {
          [WS_METHODS.memoryRead]: receive,
          [WS_METHODS.memoryMove]: receive,
        } as unknown as WsRpcProtocolClient;
        const supervisor = yield* supervisorFor(client, {
          environment: { capabilities: { memory: { protocolVersion: 1, scopeMoves: supported } } },
        } as ServerConfig);
        const provide = Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisor,
        );
        const permit = Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void });
        const read = { memorySpaceId, memoryId };
        const move = {
          ...read,
          operationId: MemoryOperationId.make("00000000-0000-4000-8000-000000000003"),
          expectedHeads: [],
          expectedScopeVersion: 0,
          fromScope: { kind: "user" as const },
          toScope: { kind: "user" as const },
        };
        yield* requestGuarded(WS_METHODS.memoryRead, { ...read, includeScopeVersion: true }).pipe(
          provide,
          permit,
        );
        const result = yield* requestGuarded(WS_METHODS.memoryMove, move).pipe(
          provide,
          permit,
          Effect.result,
        );
        expect(wire).toEqual(supported ? [{ ...read, includeScopeVersion: true }, move] : [read]);
        if (supported) expect(result._tag).toBe("Success");
        else
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "EnvironmentRpcUnavailableError" },
          });
      }),
  );
});
