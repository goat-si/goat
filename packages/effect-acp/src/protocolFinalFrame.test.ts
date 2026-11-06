import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as AcpProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encoder = new TextEncoder();
const encodeUnknownJsonString = JSON.stringify;

it.effect("answers a pending request from a final response without a trailing newline", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
      stdio,
      serverRequestMethods: new Set(),
    });
    const pending = yield* transport.request("x/test", { hello: "world" }).pipe(Effect.forkScoped);
    yield* Queue.take(output);
    yield* Queue.offer(
      input,
      encoder.encode(encodeUnknownJsonString({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
    );
    yield* Queue.end(input);

    assert.deepEqual(yield* Fiber.join(pending), { ok: true });
  }),
);
