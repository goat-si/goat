import { assert, it } from "@effect/vitest";
import type { ComputerUseLeaseUpdate } from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";

const call = (id: number, name: string, args: object) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

it.effect(
  "refuses calls that take the screen while another thread holds apps, and forwards background input",
  () =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<string, Cause.Done>();
      const output = yield* Queue.unbounded<string>();
      const toDriver = yield* Queue.unbounded<string>();
      const fromDriver = yield* Queue.unbounded<string, Cause.Done>();
      const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done>();
      yield* runLeaseProxy({
        controlId: "control:one",
        expiresAt: DateTime.makeUnsafe("1970-01-01T00:30:00.000Z"),
        input: Stream.fromQueue(input),
        output: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
        leaseUpdates: Stream.fromQueue(updates),
        startDriver: Effect.succeed({
          send: (line: string) => Queue.offer(toDriver, line).pipe(Effect.asVoid),
          lines: Stream.fromQueue(fromDriver),
          kill: Queue.end(fromDriver),
        }),
        revokeSessions: () => Effect.void,
      }).pipe(Effect.scoped, Effect.forkChild);
      // Even a control on every app shares the screen with another thread's grant.
      yield* Queue.offer(updates, {
        state: "active",
        controlId: "control:one",
        expiresAt: "1970-01-01T00:30:00.000Z",
        shared: true,
      });
      const window = { pid: 4, window_id: 9 };
      const screenTaking = [
        call(1, "bring_to_front", window),
        call(2, "click", { ...window, x: 5, y: 5, delivery_mode: "foreground" }),
        call(3, "move_cursor", { ...window, x: 5, y: 5 }),
      ];
      for (const [index, line] of screenTaking.entries()) {
        yield* Queue.offer(input, line);
        const answer = JSON.parse(yield* Queue.take(output)) as {
          readonly id: number;
          readonly result: { readonly structuredContent: object };
        };
        assert.equal(answer.id, index + 1);
        assert.deepInclude(answer.result.structuredContent, {
          refused: "targetRefused",
          detail: "screen_shared",
        });
      }
      assert.equal(yield* Queue.size(toDriver), 0);
      yield* Queue.offer(input, call(4, "click", { ...window, x: 5, y: 5 }));
      assert.equal((JSON.parse(yield* Queue.take(toDriver)) as { readonly id: number }).id, 4);
    }),
);
