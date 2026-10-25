import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import { makeLeaseProxyHandshake } from "./ComputerUseLeaseProxyHandshake.ts";

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

/**
 * The handshake answerer over drivers that answer each request at once, unless held by a gate,
 * with the lines it sends the provider in "sent" (#1622).
 */
const setup = (listing: () => unknown = () => ({ tools: [] })) =>
  Effect.gen(function* () {
    const sent: Array<Record<string, unknown>> = [];
    const ended = yield* Deferred.make<string>();
    const gate = yield* Deferred.make<void>();
    let open = true;
    let starts = 0;
    let own = 0;
    const handshake = [INITIALIZE];
    const answerer = makeLeaseProxyHandshake({
      handshake,
      ownId: (kind) => "goat-proxy:" + kind + ":" + own++,
      output: (line) => Effect.sync(() => void sent.push(JSON.parse(line))),
      ownAnswers: new Map<string, Deferred.Deferred<Envelope | undefined>>(),
      ended,
      endAnswer: (id, _method, reason) => JSON.stringify({ id, ended: reason }),
      startDriver: Effect.gen(function* () {
        starts++;
        const lines = yield* Queue.unbounded<string>();
        return {
          send: (line: string) =>
            Effect.gen(function* () {
              const message = JSON.parse(line) as { id?: string; method?: string };
              if (message.id === undefined) return;
              if (!open) yield* Deferred.await(gate);
              yield* Queue.offer(
                lines,
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: message.method === "tools/list" ? listing() : { serverInfo: {} },
                }),
              );
            }),
          lines: Stream.fromQueue(lines),
          kill: Effect.void,
        };
      }),
    });
    return {
      answerer,
      sent,
      ended,
      gate,
      hold: () => void (open = false),
      starts: () => starts,
    };
  });

describe("handshake answers while computer use is paused (#1622)", () => {
  it.effect("a cancel that comes before the answer starts stops it: no child, no answer", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      const answering = s.answerer.answer(1, "initialize", INITIALIZE, Effect.void);
      s.answerer.cancel(JSON.stringify(1));
      yield* answering;
      assert.deepEqual(s.sent, []);
      assert.equal(s.starts(), 0);
    }),
  );

  it.effect("an id with an answer still pending is reported pending", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      s.hold();
      const answering = yield* s.answerer
        .answer(1, "initialize", INITIALIZE, Effect.void)
        .pipe(Effect.forkChild);
      assert.isTrue(s.answerer.pending(JSON.stringify(1)));
      yield* Deferred.succeed(s.gate, undefined);
      yield* Fiber.join(answering);
      assert.isFalse(s.answerer.pending(JSON.stringify(1)));
    }),
  );

  it.effect("after the control ended a remembered answer is refused as ended", () =>
    Effect.gen(function* () {
      const s = yield* setup();
      s.answerer.remember("tools/list", { id: 7, result: { tools: [] } } as Envelope);
      yield* Deferred.succeed(s.ended, "stopped");
      yield* s.answerer.answer(2, "tools/list", TOOLS, Effect.void);
      assert.deepEqual(s.sent, [{ id: 2, ended: "stopped" }]);
    }),
  );

  it.effect("a borrowed tool list older than the resumed child's never replaces it", () =>
    Effect.gen(function* () {
      let version = "old";
      const s = yield* setup(() => ({ tools: [{ name: version }] }));
      s.hold();
      const borrowing = yield* s.answerer
        .answer(2, "tools/list", TOOLS, Effect.void)
        .pipe(Effect.forkChild);
      // The resumed child reports the newer list while the borrowed child still answers.
      s.answerer.remember("tools/list", {
        id: 9,
        result: { tools: [{ name: "new" }] },
      } as Envelope);
      yield* Deferred.succeed(s.gate, undefined);
      yield* Fiber.join(borrowing);
      version = "new";
      s.sent.length = 0;
      yield* s.answerer.answer(3, "tools/list", TOOLS, Effect.void);
      assert.deepEqual(s.sent, [{ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "new" }] } }]);
    }),
  );

  it.effect("of two borrowed tool lists answering at once, the later answer stands", () =>
    Effect.gen(function* () {
      let calls = 0;
      const s = yield* setup(() => ({ tools: [{ name: "list " + ++calls }] }));
      s.hold();
      const first = yield* s.answerer
        .answer(2, "tools/list", TOOLS, Effect.void)
        .pipe(Effect.forkChild);
      const second = yield* s.answerer
        .answer(4, "tools/list", TOOLS.replace('"id":2', '"id":4'), Effect.void)
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(s.gate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      const replies = s.sent.map((line) => [line.id, line.result]);
      assert.deepEqual(replies, [
        [2, { tools: [{ name: "list 1" }] }],
        [4, { tools: [{ name: "list 2" }] }],
      ]);
      s.sent.length = 0;
      yield* s.answerer.answer(5, "tools/list", TOOLS, Effect.void);
      assert.deepEqual(s.sent, [
        { jsonrpc: "2.0", id: 5, result: { tools: [{ name: "list 2" }] } },
      ]);
    }),
  );
});
