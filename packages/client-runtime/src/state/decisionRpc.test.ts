import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
  type DecisionAnswerInput,
  type DecisionItem,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const environmentId = EnvironmentId.make("decision-origin");
const item: DecisionItem = {
  id: "same-id",
  source: "decision",
  from: { host: "worker" },
  title: "Choose rollout",
  context: "Remote destination",
  options: [{ id: "stage", label: "Stage", consequence: "Canary" }],
  recommended: null,
  requiredProfile: "maintainer",
  expiresAt: null,
  status: "open",
  answer: null,
  answeredBy: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  humanRequired: false,
};

const makeHarness = Effect.fn("DecisionRpcTest.makeHarness")(function* () {
  const calls: { method: string; input: unknown }[] = [];
  const client = {
    [WS_METHODS.decisionGet]: (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "get", input });
        return item;
      }),
    [WS_METHODS.decisionAnswer]: (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "answer", input });
        return { ...item, status: "answered" as const };
      }),
    [WS_METHODS.decisionList]: (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method: "list", input });
        return { items: [item], unavailableHosts: [], truncated: false };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Origin",
      httpBaseUrl: "https://origin.example.test",
      wsBaseUrl: "wss://origin.example.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const cache = EnvironmentCacheStore.of({
    loadShellMeta: () => Effect.succeedNone,
    saveShellMeta: () => Effect.void,
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(EnvironmentCacheStore, cache),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(null),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
  );
  return { atoms, registry, calls };
});

it.effect(
  "baseline-failing: gets a decision through its origin with the destination host intact",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, calls } = yield* makeHarness();
        const result = yield* Effect.promise(() =>
          atoms.getDecision.run(registry, {
            environmentId,
            input: { id: "same-id", host: "worker" },
          }),
        );
        expect(result).toMatchObject({
          _tag: "Success",
          value: { id: "same-id", from: { host: "worker" } },
        });
        expect(calls).toEqual([{ method: "get", input: { id: "same-id", host: "worker" } }]);
      }),
    ),
);

it.effect("preservation: preserves the destination host when answering through the origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { atoms, registry, calls } = yield* makeHarness();
      const input = {
        id: "same-id",
        host: "worker",
        optionId: "stage",
        reason: "Canary first",
      } satisfies DecisionAnswerInput & { host: string };
      const result = yield* Effect.promise(() =>
        atoms.answerDecision.run(registry, { environmentId, input }),
      );
      expect(result._tag).toBe("Success");
      expect(calls).toEqual([{ method: "answer", input }]);
    }),
  ),
);
