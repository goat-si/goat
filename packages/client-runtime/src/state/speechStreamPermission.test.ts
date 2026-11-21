import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  SPEECH_STREAM_WS_METHODS,
  type AuthSessionState,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { runStreamInSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { withEnvironmentRpcGuard } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("speech-fixture");
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const state = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "fixture",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});

it.effect("checks the current destination grant before subscribing to live speech", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      registry.mount(sessions(env));
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      let subscriptions = 0;
      const session = {
        client: {
          [SPEECH_STREAM_WS_METHODS.events]: () =>
            Stream.fromEffect(
              Effect.sync(() => {
                subscriptions++;
                return { type: "ready" as const };
              }),
            ),
        },
      } as unknown as RpcSession;
      const supervisor = {
        target: { environmentId: env, label: "fixture" },
        session: yield* SubscriptionRef.make(Option.some(session)),
      } as unknown as EnvironmentSupervisor["Service"];
      const subscribe = () =>
        runStreamInSession(session, SPEECH_STREAM_WS_METHODS.events, { streamId: "fixture" }).pipe(
          Stream.runCollect,
          Effect.provideService(EnvironmentSupervisor, supervisor),
          withEnvironmentRpcGuard(runtime, registry),
        );
      registry.set(sessions(env), AsyncResult.success(state(false)));
      expect((yield* Effect.flip(subscribe()))._tag).toBe("EnvironmentAuthorizationError");
      expect(subscriptions).toBe(0);
      registry.set(sessions(env), AsyncResult.success(state(true)));
      yield* subscribe();
      expect(subscriptions).toBe(1);
    }),
  ),
);
