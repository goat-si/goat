import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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

/** Opens route only to the in-process server browser, so hosts that open tabs connect as it. */
const SERVER_BROWSER = { inProcess: true } as const;

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void = () => {},
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

it.effect(
  "keeps another thread's request alive when one request times out on the shared server browser",
  () =>
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const clientId = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
      const delivered = yield* Queue.unbounded<RoutedRequest>();
      const connected = yield* Deferred.make<void>();
      const requests = requestsFrom(
        (yield* broker.connect(makeHost({ clientId }), SERVER_BROWSER)).pipe(
          Stream.tap((event) =>
            event.type === "connected"
              ? Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      );
      yield* Stream.runForEach(requests, (request) => Queue.offer(delivered, request)).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(connected);
      const otherScope = {
        ...scope,
        requestNamespace: "provider-session-2",
        thread: {
          threadId: ThreadId.make("thread-2"),
          providerSessionId: "provider-session-2",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      };

      const otherWait = yield* broker
        .invoke<string>({ scope: otherScope, operation: "waitFor", input: {}, timeoutMs: 40_000 })
        .pipe(Effect.result, Effect.forkScoped);
      const otherRequest = yield* Queue.take(delivered);
      // The browser never answers this one, as when it waits behind the thread's own running action.
      const stalled = yield* broker
        .invoke<string>({ scope, operation: "evaluate", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(delivered);

      yield* TestClock.adjust("16 seconds");
      expect((yield* Fiber.join(stalled))._tag).toBe("PreviewAutomationTimeoutError");

      yield* broker.respond({
        clientId,
        connectionId: otherRequest.connectionId,
        requestId: otherRequest.requestId,
        ok: true,
        result: "ready",
      });
      expect(yield* Fiber.join(otherWait)).toEqual(Result.succeed("ready"));
    }),
);
