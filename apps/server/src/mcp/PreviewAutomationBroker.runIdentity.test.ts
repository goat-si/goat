import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

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

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

it.effect("forwards the run identity without changing the browser session owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
      const events = yield* broker.connect(
        { clientId: "client-1", environmentId: scope.environmentId },
        { inProcess: true },
      );
      const requests = events.pipe(
        Stream.filterMap((event) =>
          event.type === "connected"
            ? Result.failVoid
            : Result.succeed<RoutedRequest>({ ...event.request, connectionId: event.connectionId }),
        ),
      );
      const received = yield* Deferred.make<RoutedRequest>();
      yield* Stream.runForEach(requests, (request) =>
        Deferred.succeed(received, request).pipe(
          Effect.andThen(
            broker.respond({
              clientId: "client-1",
              connectionId: request.connectionId,
              requestId: request.requestId,
              ok: true,
              result: {},
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.invoke({ scope, operation: "open", input: {}, runId: "run-1" });
      const request = yield* Deferred.await(received);
      expect(request).toMatchObject({
        runId: "run-1",
        agentSessionId: `${scope.environmentId}\u0000${scope.thread.providerSessionId}\u0000${scope.thread.threadId}`,
      });
    }),
  ),
);
