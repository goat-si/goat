import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const elicitationForm = {
  sessionId: "session-1",
  mode: "form" as const,
  message: "Continue?",
  requestedSchema: {
    type: "object" as const,
    properties: { choice: { type: "string" as const } },
    required: ["choice"],
  },
};
const decodeWireResponse = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWireError = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.Finite }) })),
);

const decodeRequestId = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Finite })),
);

const makeInitializedFormClient = Effect.gen(function* () {
  const transport = yield* makeInMemoryStdio();
  const acp = yield* AcpClient.make(transport.stdio);
  const initializing = yield* acp.agent
    .initialize({ protocolVersion: 2, clientCapabilities: { elicitation: { form: {} } } })
    .pipe(Effect.forkChild);
  const request = yield* decodeRequestId(yield* Queue.take(transport.output));
  yield* Queue.offer(
    transport.input,
    yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: 2, info: { name: "fixture", version: "1" } },
    }),
  );
  yield* Fiber.join(initializing);
  return { acp, ...transport };
});

it.effect.each(["accept", "decline", "cancel"] as const)(
  "returns a flat %s action to the SDK and preserves the legacy response",
  (action) =>
    Effect.gen(function* () {
      for (const method of ["elicitation/create", "session/elicitation"]) {
        const { acp, input, output } = yield* makeInitializedFormClient;
        const answer = action === "accept" ? { action, content: { choice: "yes" } } : { action };
        const response = { ...answer, _meta: { trace: "fixture" } };
        yield* acp.handleElicitation((request) => {
          assert.deepEqual(request, elicitationForm);
          return Effect.succeed(response);
        });
        yield* Queue.offer(
          input,
          yield* encodeJsonl(jsonRpcRequest(method, AcpSchema.CreateElicitationRequest), {
            jsonrpc: "2.0",
            id: 71,
            headers: [],
            method,
            params: elicitationForm,
          }),
        );
        const received = yield* decodeWireResponse(yield* Queue.take(output));
        assert.deepEqual(received, {
          jsonrpc: "2.0",
          id: 71,
          result:
            method === "elicitation/create" ? response : { action: answer, _meta: response._meta },
        });
      }
    }).pipe(Effect.scoped),
);

it.effect.each(["elicitation/complete", "session/elicitation/complete"])(
  "delivers %s notifications to the completion handler",
  (method) =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      const received = yield* Deferred.make<AcpSchema.CompleteElicitationNotification>();
      yield* acp.handleElicitationComplete((notification) =>
        Deferred.succeed(received, notification).pipe(Effect.asVoid),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcNotification(method, AcpSchema.CompleteElicitationNotification), {
          jsonrpc: "2.0",
          method,
          params: { elicitationId: "elicitation-1" },
        }),
      );
      assert.deepEqual(yield* Deferred.await(received), { elicitationId: "elicitation-1" });
    }).pipe(Effect.scoped),
);

it.effect("rejects malformed SDK elicitation without calling the question handler", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const acp = yield* AcpClient.make(stdio);
    let calls = 0;
    yield* acp.handleElicitation(() => {
      calls++;
      return Effect.succeed({ action: "cancel" as const });
    });
    yield* Queue.offer(
      input,
      yield* encodeJsonl(jsonRpcRequest("elicitation/create", Schema.Unknown), {
        jsonrpc: "2.0",
        id: 73,
        headers: [],
        method: "elicitation/create",
        params: { ...elicitationForm, message: 123 },
      }),
    );
    const response = yield* decodeWireError(yield* Queue.take(output));
    assert.equal(response.error.code, -32602);
    assert.equal(calls, 0);
  }).pipe(Effect.scoped),
);

it.effect("returns method-not-found when SDK elicitation has no question handler", () =>
  Effect.gen(function* () {
    const { input, output } = yield* makeInitializedFormClient;
    yield* Queue.offer(
      input,
      yield* encodeJsonl(jsonRpcRequest("elicitation/create", AcpSchema.CreateElicitationRequest), {
        jsonrpc: "2.0",
        id: 74,
        headers: [],
        method: "elicitation/create",
        params: elicitationForm,
      }),
    );
    const response = yield* decodeWireError(yield* Queue.take(output));
    assert.equal(response.error.code, -32601);
  }).pipe(Effect.scoped),
);

it.effect.each(["session/elicitation", "_session/elicitation", "elicitation/create"])(
  "denies unsolicited form and URL requests before initialization via %s",
  (method) =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      let calls = 0;
      yield* acp.handleElicitation(() => {
        calls++;
        return Effect.succeed({ action: "accept" as const });
      });
      const url = {
        sessionId: "session-1",
        mode: "url",
        message: "Sign in",
        url: "https://example.test/auth",
        elicitationId: "auth-1",
      };
      const codes = [];
      for (const [id, params] of [url, elicitationForm].entries()) {
        yield* Queue.offer(
          input,
          yield* encodeJsonl(jsonRpcRequest(method, Schema.Unknown), {
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
        );
        const response = yield* decodeWireResponse(yield* Queue.take(output));
        codes.push((response as { error?: { code: number } }).error?.code);
      }
      assert.deepEqual({ calls, codes }, { calls: 0, codes: [-32602, -32602] });
    }).pipe(Effect.scoped),
);

it.effect.each([
  [1, "session/elicitation"],
  [1, "_session/elicitation"],
  [1, "elicitation/create"],
  [2, "elicitation/create"],
] as const)(
  "rejects a URL elicitation the client did not advertise on wire v%s (%s)",
  ([wireVersion, method]) =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      const init = yield* acp.agent
        .initialize({ protocolVersion: 2, clientCapabilities: { elicitation: { form: {} } } })
        .pipe(Effect.forkChild);
      const initialize = yield* decodeWireResponse(yield* Queue.take(output));
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
          jsonrpc: "2.0",
          id: (initialize as { id: number }).id,
          result:
            wireVersion === 2
              ? { protocolVersion: 2, info: { name: "fixture", version: "1" }, capabilities: {} }
              : { protocolVersion: 1, agentCapabilities: {} },
        }),
      );
      yield* Fiber.join(init);
      const calls = yield* Ref.make(0);
      yield* acp.handleElicitation(() =>
        Ref.update(calls, (n) => n + 1).pipe(Effect.as({ action: "accept" as const })),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcRequest(method, Schema.Unknown), {
          jsonrpc: "2.0",
          id: 81,
          headers: [],
          method,
          params: {
            sessionId: "session-1",
            mode: "url",
            message: "Sign in",
            url: "https://example.test/auth",
            elicitationId: "auth-1",
          },
        }),
      );
      const response = yield* decodeWireError(yield* Queue.take(output));
      assert.equal(response.error.code, -32602);
      assert.equal(yield* Ref.get(calls), 0);
    }).pipe(Effect.scoped),
);
