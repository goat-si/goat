import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("Codex protocol defect isolation", (it) => {
  it.effect("answers an incoming request when its handler dies", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Effect.die("handler defect"),
      });
      yield* Queue.offer(
        input,
        new TextEncoder().encode(`${encode({ id: 1, method: "unknown", params: {} })}\n`),
      );
      assert.deepEqual(yield* decode(yield* Queue.take(output)), {
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
    }),
  );
  it.effect("fails pending requests if the writer dies", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio: Stdio.make({
          ...stdio,
          stdout: () => Sink.forEach(() => Effect.die("writer defect")),
        }),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });
      const failure = yield* transport.request("thread/read", {}).pipe(Effect.flip);
      assert.instanceOf(failure, CodexError.CodexAppServerTransportError);
      assert.strictEqual(yield* Deferred.await(terminated), failure);
    }),
  );
  it.effect("fails pending requests if exit classification dies", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        terminationError: Effect.die("exit defect"),
      });
      const request = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.end(input);
      const error = yield* Fiber.join(request).pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
    }),
  );
  it.effect("does not report normal scope shutdown as transport failure", () =>
    Effect.gen(function* () {
      let terminations = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { stdio } = yield* makeInMemoryStdio();
          yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
            stdio,
            onTermination: () =>
              Effect.sync(() => {
                terminations++;
              }),
          });
        }),
      );
      assert.equal(terminations, 0);
    }),
  );
});
