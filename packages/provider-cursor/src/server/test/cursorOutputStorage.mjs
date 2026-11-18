import * as NodeAssert from "node:assert/strict";
import * as NodeV8 from "node:v8";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { makeCommandOutputGate } from "../commandOutputGate.ts";
import { makeShellOutputCoalescer } from "../shellOutputCoalescer.ts";

const mib = 1024 * 1024;
const tail = "retained output\n".repeat(4096);
const oversized = () => {
  const chunk = "x".repeat(32 * mib) + tail;
  NodeAssert.equal(chunk.charCodeAt(0), 120);
  return chunk;
};
const usedHeap = () => {
  globalThis.gc();
  globalThis.gc();
  return NodeV8.getHeapStatistics().used_heap_size;
};

async function queueCommandOutput() {
  const queue = Effect.runSync(Queue.unbounded());
  const gate = Effect.runSync(makeCommandOutputGate(tail.length));
  await Effect.runPromise(
    gate.offer(queue, { type: "command_output.delta", chunk: oversized() }, () => false),
  );
  return async () => (await Effect.runPromise(gate.take(queue))).chunk;
}

function queueShellOutput() {
  const firstDispatch = Promise.withResolvers();
  const coalescer = makeShellOutputCoalescer(() => firstDispatch.promise);
  const push = (data) =>
    coalescer.push({
      toolCallId: "shell",
      event: { case: "stdout", value: { data } },
    });
  push("in flight");
  push(oversized());
  return async () => {
    const [pending] = coalescer.takeForTool("shell");
    firstDispatch.resolve();
    await coalescer.idle();
    return pending.event.value.data;
  };
}

const commandQueue = process.argv[2] === "command";
const before = usedHeap();
const read = commandQueue ? await queueCommandOutput() : queueShellOutput();
const retained = usedHeap() - before;
NodeAssert.ok(retained < 16 * mib, `Queued tail retained ${(retained / mib).toFixed(1)} MiB`);
const queued = await read();
NodeAssert.equal(queued, commandQueue ? tail : "x".repeat(256 * 1024 - tail.length) + tail);
