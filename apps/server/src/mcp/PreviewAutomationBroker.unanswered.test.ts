import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationTimeoutError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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

const host: PreviewAutomationHost = { clientId: "client-1", environmentId: scope.environmentId };

type Delivered = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

/** Answers every status at once and hands the first wait to the test, which decides its fate. */
const serveHost = Effect.fn("PreviewAutomationBrokerUnansweredTest.serveHost")(function* (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) {
  const wait = yield* Deferred.make<Delivered>();
  const events = yield* broker.connect(host);
  yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") return Effect.void;
    const request = { ...event.request, connectionId: event.connectionId };
    return request.operation === "waitFor"
      ? Deferred.succeed(wait, request).pipe(Effect.asVoid)
      : broker.respond({
          clientId: host.clientId,
          connectionId: request.connectionId,
          requestId: request.requestId,
          ok: true,
          result: { answered: request.requestId },
        });
  }).pipe(Effect.forkScoped);
  return wait;
});

it.effect("an interrupted request ignores its late answer and keeps its host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const wait = yield* serveHost(broker);
      const waiting = yield* broker
        .invoke({ scope, operation: "waitFor", input: { text: "Ready" }, timeoutMs: 1_000 })
        .pipe(Effect.forkScoped);
      const delivered = yield* Deferred.await(wait);
      yield* Fiber.interrupt(waiting);
      const exit = waiting.pollUnsafe();
      expect(exit !== undefined && Exit.hasInterrupts(exit)).toBe(true);
      yield* broker.respond({
        clientId: host.clientId,
        connectionId: delivered.connectionId,
        requestId: delivered.requestId,
        ok: true,
        result: "late",
      });
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toMatchObject({
        answered: expect.any(String),
      });
    }),
  ),
);

it.effect(
  "a request its host never answers times out at its own deadline plus the host grace and drops that host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const wait = yield* serveHost(broker);
        const waiting = yield* broker
          .invoke<void>({ scope, operation: "waitFor", input: { text: "Ready" }, timeoutMs: 1_000 })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(wait);
        yield* TestClock.adjust("1999 millis");
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        const error = yield* Fiber.join(waiting);
        // The broker's own timeout: the host said nothing, so there is no remote tag to read.
        expect(error).toBeInstanceOf(PreviewAutomationTimeoutError);
        expect(error).not.toHaveProperty("remoteTag");
        const next = yield* broker
          .invoke<void>({ scope, operation: "status", input: {} })
          .pipe(Effect.flip);
        expect(next).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      }),
    ),
);
