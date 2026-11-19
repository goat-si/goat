import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  SPEECH_STREAM_WS_METHODS,
  type AuthSessionState,
} from "@goat/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@goat/client-runtime/connection";
import type { RpcSession } from "@goat/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

const fixture = vi.hoisted(() => ({
  runtime: undefined as unknown,
  registry: undefined as unknown,
  sessions: undefined as unknown,
}));
vi.mock("../connection/runtime", () => ({
  get connectionAtomRuntime() {
    return fixture.runtime;
  },
}));
vi.mock("./atomRegistry", () => ({
  get appAtomRegistry() {
    return fixture.registry;
  },
}));
vi.mock("@goat/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: fixture.sessions }),
}));

it.effect("falls back for an old server and never sends audio on a replaced connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("fixture");
      const sessions = Atom.family((_id: EnvironmentId) =>
        Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
      );
      const registry = AtomRegistry.make();
      registry.mount(sessions(environmentId));
      registry.set(
        sessions(environmentId),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "fixture",
          },
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        }),
      );
      let supported = false;
      let starts = 0;
      let feeds = 0;
      const session = {
        initialConfig: Effect.sync(() => ({ speechStreamingV1: supported })),
        client: {
          [SPEECH_STREAM_WS_METHODS.start]: () =>
            Effect.sync(() => {
              starts++;
              return { streamId: "fixture" };
            }),
          [SPEECH_STREAM_WS_METHODS.feed]: () =>
            Effect.sync(() => {
              feeds++;
              return {};
            }),
        },
      } as unknown as RpcSession;
      const sessionRef = yield* SubscriptionRef.make(Option.some(session));
      const supervisor = {
        target: { environmentId, label: "fixture" },
        session: sessionRef,
      } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      fixture.runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
            effect.pipe(
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            ),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      );
      fixture.registry = registry;
      fixture.sessions = sessions;
      const { createLiveSpeechTransport } = yield* Effect.promise(
        () => import("./liveSpeechTransport"),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      yield* Effect.gen(function* () {
        let allowed = true;
        const transport = createLiveSpeechTransport(environmentId, () => allowed);
        yield* Effect.promise(() => expect(transport.start("en")).rejects.toThrow("unavailable"));
        expect(starts).toBe(0);
        supported = true;
        expect(yield* Effect.promise(() => transport.start("en"))).toEqual({ streamId: "fixture" });
        yield* SubscriptionRef.set(sessionRef, Option.some({ ...session } as RpcSession));
        yield* Effect.promise(() =>
          expect(
            transport.feed({ streamId: "fixture", sequence: 0, audioBase64: "AAA=" }),
          ).rejects.toThrow(),
        );
        expect(feeds).toBe(0);
        yield* SubscriptionRef.set(sessionRef, Option.some(session));
        allowed = false;
        yield* Effect.promise(() =>
          expect(
            transport.feed({ streamId: "fixture", sequence: 0, audioBase64: "AAA=" }),
          ).rejects.toThrow(),
        );
        allowed = true;
        registry.set(
          sessions(environmentId),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "fixture",
            },
            scopes: [],
            permissions: [],
          }),
        );
        yield* Effect.promise(() =>
          expect(
            transport.feed({ streamId: "fixture", sequence: 0, audioBase64: "AAA=" }),
          ).rejects.toThrow(),
        );
        expect(feeds).toBe(0);
      });
    }),
  ),
);
