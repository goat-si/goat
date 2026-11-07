import { expect, it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import {
  makeFactory,
  awaitSocket,
  awaitRequest,
  encodeJson,
  TestWebSocket,
} from "./sessionTestHarness.ts";
import { PREPARED } from "./sessionTestFixtures.ts";

it.effect("fresh probe socket sends only server.probe and closes with its scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const scope = yield* Scope.make();
      const probe = yield* factory.openProbe(PREPARED, true).pipe(Scope.provide(scope));
      const fiber = yield* Effect.forkChild(probe.probe);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      const request = yield* awaitRequest(socket);
      expect(request.tag).toBe(WS_METHODS.serverProbe);
      socket.serverMessage(
        encodeJson({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: {} } }),
      );
      yield* Fiber.join(fiber);
      expect(socket.sent.filter((message) => message.includes('"_tag":"Request"'))).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
      expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    }),
  ),
);
