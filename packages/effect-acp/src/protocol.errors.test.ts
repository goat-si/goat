import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect("preserves application error data in outgoing extension responses", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const acknowledged = yield* Deferred.make<string>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onExtRequest: () =>
          Effect.fail(AcpError.AcpRequestError.invalidParams("bad input", { field: "name" })),
        onOutgoingResponse: (requestId) =>
          Deferred.succeed(acknowledged, requestId).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encoder.encode(
          encodeUnknownJsonString({
            jsonrpc: "2.0",
            id: "peer-1",
            method: "x/test",
            params: {},
          }) + "\n",
        ),
      );

      assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
        jsonrpc: "2.0",
        id: "peer-1",
        error: { code: -32602, message: "bad input", data: { field: "name" } },
      });
      assert.equal(yield* Deferred.await(acknowledged), "peer-1");
    }),
  );

  it.effect("completes a batch with successful and failed extension responses", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const acknowledgements = yield* Queue.unbounded<string>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onExtRequest: (method) =>
          method === "x/success"
            ? Effect.succeed({ ok: true })
            : Effect.fail(AcpError.AcpRequestError.invalidParams("bad input", { field: "name" })),
        onOutgoingResponse: (requestId) => Queue.offer(acknowledgements, requestId),
      });

      yield* Queue.offer(
        input,
        encoder.encode(
          encodeUnknownJsonString([
            { jsonrpc: "2.0", id: 0, method: "x/success", params: {} },
            { jsonrpc: "2.0", id: "peer-1", method: "x/failure", params: {} },
          ]) + "\n",
        ),
      );

      assert.deepEqual(JSON.parse(yield* Queue.take(output)), [
        { jsonrpc: "2.0", id: 0, result: { ok: true } },
        {
          jsonrpc: "2.0",
          id: "peer-1",
          error: { code: -32602, message: "bad input", data: { field: "name" } },
        },
      ]);
      assert.equal(yield* Queue.take(acknowledgements), "peer-1");
    }),
  );

  it.effect.each([
    {
      name: "typed failure",
      cause: [{ _tag: "Fail", error: { code: -32602, message: "bad input", data: null } }],
      error: { code: -32602, message: "bad input", data: null },
    },
    {
      name: "typed failure with interruption",
      cause: [
        { _tag: "Fail", error: { code: -32602, message: "bad input", data: { field: "name" } } },
        { _tag: "Interrupt", fiberId: null },
      ],
      error: { code: -32602, message: "bad input", data: { field: "name" } },
    },
    {
      name: "defect",
      cause: [{ _tag: "Die", defect: "private defect" }],
      error: { code: -32603, message: "Internal error" },
    },
    {
      name: "failure with a defect",
      cause: [
        { _tag: "Fail", error: { code: -32602, message: "bad input" } },
        { _tag: "Die", defect: "private defect" },
      ],
      error: { code: -32603, message: "Internal error" },
    },
  ] as const)("emits a standard ACP error for a core $name", ({ cause, error }) =>
    Effect.gen(function* () {
      const { stdio, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      yield* transport.serverProtocol.send(0, {
        _tag: "Exit",
        requestId: 0,
        exit: { _tag: "Failure", cause },
      });

      assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
        jsonrpc: "2.0",
        id: 0,
        error,
      });
    }),
  );
});
