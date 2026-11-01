import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ThreadId,
  type PreviewAutomationHost,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

it.effect("an exact bound tab never reroutes after host replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = makeHost({ clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID });
      const firstConnected = yield* Deferred.make<string>();
      const first = yield* broker.connect(host);
      yield* Stream.runForEach(first, (event) =>
        event.type === "connected"
          ? Deferred.succeed(firstConnected, event.connectionId).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkScoped);
      const oldConnection = yield* Deferred.await(firstConnected);
      yield* broker.focusHost({
        clientId: host.clientId,
        environmentId: scope.environmentId,
        connectionId: oldConnection,
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId: PreviewTabId.make("tab-1") }],
      });
      const secondConnected = yield* Deferred.make<string>();
      const second = yield* broker.connect(host);
      yield* Stream.runForEach(second, (event) =>
        event.type === "connected"
          ? Deferred.succeed(secondConnected, event.connectionId).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkScoped);
      const newConnection = yield* Deferred.await(secondConnected);
      yield* broker.focusHost({
        clientId: host.clientId,
        environmentId: scope.environmentId,
        connectionId: newConnection,
        focused: true,
        liveTabs: [{ threadId: scope.thread.threadId, tabId: PreviewTabId.make("tab-1") }],
      });
      const result = yield* broker
        .invoke({
          scope,
          operation: "click",
          input: { x: 1, y: 1 },
          exact: {
            browserInstanceId: host.clientId,
            connectionId: oldConnection,
            tabId: PreviewTabId.make("tab-1"),
            controlGeneration: 0,
            origin: null,
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  ),
);

it.effect("a host's refusal before any input left reaches the agent as not dispatched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let answered = 0;
      yield* Stream.runForEach(yield* broker.connect(makeHost()), (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "client-1",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationSecretFillRefusedError",
                message: "Nothing was filled.",
                // The first refusal came before anything was typed; the second may have typed.
                ...(answered++ === 0 ? { detail: { beforeInput: true } } : {}),
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const invoke = broker
        .invoke<void>({ scope, operation: "status", input: {}, timeoutMs: 2_000 })
        .pipe(Effect.flip);
      expect(yield* invoke).toMatchObject({ dispatched: false });
      expect(yield* invoke).not.toHaveProperty("dispatched");
    }),
  ),
);

it.effect("a deadline the host hit before any input left reaches the agent as not dispatched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      let answered = 0;
      yield* Stream.runForEach(yield* broker.connect(makeHost()), (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "client-1",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationTimeoutError",
                message: "The target was not ready before the deadline, so no input was sent.",
                // The first expired before input; the second timed out after input may have left.
                ...(answered++ === 0 ? { detail: { beforeInput: true } } : {}),
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const invoke = broker
        .invoke<void>({ scope, operation: "type", input: { text: "x" }, timeoutMs: 2_000 })
        .pipe(Effect.flip);
      expect(yield* invoke).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        dispatched: false,
      });
      expect(yield* invoke).not.toHaveProperty("dispatched");
    }),
  ),
);
