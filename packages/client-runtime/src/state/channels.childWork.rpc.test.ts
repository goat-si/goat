import { CHANNEL_GATEWAY_WS_METHODS, ChannelTaskId, type ServerConfig } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type * as RpcSession from "../rpc/session.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";
import { makeEnvironmentQueryHarness, QUERY_ENVIRONMENT } from "./runtimeTestSupport.ts";

const config = Atom.make<ServerConfig | null>({
  environment: { capabilities: { goatBotChildWork: true, goatBotTaskChanges: true } },
} as ServerConfig);
const sessionState = Atom.make(
  AsyncResult.success({ authenticated: true, scopes: ["orchestration:read"] }),
);
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    initialConfigValueAtom: () => config,
    sessionStateAtom: () => sessionState,
  }),
}));

it.effect("refreshing child work retries the failed RPC and returns its next answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let requests = 0;
      const session = {
        client: {
          [CHANNEL_GATEWAY_WS_METHODS.listChildWork]: () =>
            Effect.suspend(() => {
              requests += 1;
              return requests === 1
                ? Effect.fail(
                    new EnvironmentRpcUnavailableError({
                      environmentId: QUERY_ENVIRONMENT.environmentId,
                      message: "failed first read",
                    }),
                  )
                : Effect.succeed({ groups: [] });
            }),
        },
      } as unknown as RpcSession.RpcSession;
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession: session });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const query = createChannelEnvironmentAtoms(harness.runtime).listChildWork({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { taskIds: [ChannelTaskId.make("task")] },
      });
      registry.mount(query);
      const first = yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(first)).toBe(true);
      expect(requests).toBe(1);
      registry.refresh(query);
      const second = yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      expect(second).toEqual({ groups: [] });
      expect(requests).toBe(2);
    }),
  ),
);

it.effect("an open alert detail reads the recorded answer when another client answers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const answered = yield* Deferred.make<void>();
      const observed = yield* Deferred.make<void>();
      let task = {
        openQuestions: [{ questionId: "ask", text: "Open question" }],
        answeredQuestions: [] as Array<{ questionId: string; answerText: string }>,
      };
      const session = {
        client: {
          [CHANNEL_GATEWAY_WS_METHODS.getTask]: () => Effect.sync(() => task),
          [CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges]: () =>
            Stream.concat(
              Stream.make({ revision: 0 }),
              Stream.fromEffect(Deferred.await(answered)).pipe(Stream.map(() => ({ revision: 1 }))),
            ).pipe(Stream.concat(Stream.never)),
        },
      } as unknown as RpcSession.RpcSession;
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession: session });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atoms = createChannelEnvironmentAtoms(harness.runtime);
      const environmentId = QUERY_ENVIRONMENT.environmentId;
      const query = atoms.getTask({
        environmentId,
        input: { taskId: ChannelTaskId.make("task"), attentionRequest: "ask" },
      });
      registry.mount(query);
      const read = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      expect((yield* read).openQuestions).toHaveLength(1);
      registry.subscribe(atoms.taskChanges({ environmentId, input: {} }), (result) => {
        const update = Option.getOrUndefined(AsyncResult.value(result));
        if (update && "value" in update && update.value.revision === 1) {
          registry.schedulerAsync.makeDispatcher().scheduleTask(() => {
            Deferred.doneUnsafe(observed, Exit.void);
          }, 0);
        }
      });
      task = {
        openQuestions: [],
        answeredQuestions: [{ questionId: "ask", answerText: "West" }],
      };
      yield* Deferred.succeed(answered, undefined);
      yield* Deferred.await(observed);
      expect((yield* read).answeredQuestions).toEqual(task.answeredQuestions);
    }),
  ),
);
