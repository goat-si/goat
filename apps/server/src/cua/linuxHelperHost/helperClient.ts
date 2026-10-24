// Frames are decoded with the protocol schemas; JSON.stringify only writes them.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * The server's end of the Linux helper's stdio channel (#1223): hello first, then request frames
 * answered once each, and event frames for the watch in force. Pure over a write function and
 * the lines read, so the process that runs it owns spawning and timers.
 *
 * A reply or event is trusted only from the helper this client spawned: hello's binding names
 * the process, and it must be the child's own pid; replies and events of another generation,
 * late replies and events from an ended watch are dropped (admitComputerUse*).
 */
import {
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseEventFrame,
  ComputerUseHelloReply,
  ComputerUseReplyFrame,
  admitComputerUseEvent,
  admitComputerUseReply,
  negotiateComputerUseVersion,
  type ComputerUseCapabilities,
  type ComputerUseEvent,
  type ComputerUseHelperBinding,
  type ComputerUseMethod,
  type ComputerUseWindowTarget,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodeHello = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseHelloReply));
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseReplyFrame));
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseEventFrame));

export interface HelperHello {
  readonly binding: ComputerUseHelperBinding;
  readonly capabilities: ComputerUseCapabilities;
  readonly maxFrameBytes: number;
}

export interface HelperClientOptions {
  /** Writes one frame, newline included. */
  readonly write: (line: string) => void;
  /** The spawned child's pid; hello must name this process. */
  readonly pid: number | undefined;
  readonly newId: () => string;
  /** Runs task after ms; returns a cancel. */
  readonly after: (ms: number, task: () => void) => () => void;
  /** An event of the watch in force. */
  readonly onEvent: (event: ComputerUseEvent) => void;
}

class HelperClientError extends Error {}

const encoder = new TextEncoder();

export function makeHelperClient(options: HelperClientOptions) {
  let hello: HelperHello | undefined;
  let closed = false;
  let watchId: string | undefined;
  const helloWaiter = Promise.withResolvers<HelperHello>();
  // A client closed before anyone awaits its hello must not raise an unhandled rejection.
  helloWaiter.promise.catch(() => undefined);
  const pending = new Map<
    string,
    {
      readonly resolve: (result: unknown) => void;
      readonly cancel: () => void;
      /** Runs as the reply is admitted, before the next line is read. */
      readonly admitted?: (result: unknown) => void;
    }
  >();

  const settle = (id: string, result: unknown, delivered = false) => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    entry.cancel();
    if (delivered) entry.admitted?.(result);
    entry.resolve(result);
  };

  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    watchId = undefined;
    helloWaiter.reject(new HelperClientError(reason));
    // Deleting the entry being visited is safe while iterating a Map.
    for (const id of pending.keys()) settle(id, undefined);
  };

  const readHello = (line: string) => {
    const decoded = decodeHello(line);
    if (decoded._tag === "None") return close("The helper's hello does not match the protocol.");
    const reply = decoded.value;
    if ("outcome" in reply) return close(reply.message);
    const version = negotiateComputerUseVersion(reply.serverApiVersion);
    if (version !== true) return close(version.message);
    // The pipe authenticates the helper only if the process answering is the one spawned.
    if (options.pid === undefined || reply.binding.pid !== options.pid)
      return close("The helper's hello names another process than the one GOAT started.");
    hello = {
      binding: reply.binding,
      capabilities: reply.capabilities,
      maxFrameBytes: reply.maxFrameBytes,
    };
    helloWaiter.resolve(hello);
  };

  const line = (raw: string) => {
    if (closed || raw.trim() === "") return;
    if (hello === undefined) return readHello(raw);
    const frameBytes = encoder.encode(raw).byteLength;
    const reply = decodeReply(raw);
    if (reply._tag === "Some") {
      const verdict = admitComputerUseReply({
        reply: reply.value,
        frameBytes,
        maxFrameBytes: hello.maxFrameBytes,
        generation: hello.binding.generation,
        pending: new Set(pending.keys()),
      });
      if (verdict === "deliver") settle(reply.value.id, reply.value.result, true);
      return;
    }
    const event = decodeEvent(raw);
    if (event._tag === "None") return;
    const verdict = admitComputerUseEvent({
      frame: event.value,
      frameBytes,
      maxFrameBytes: hello.maxFrameBytes,
      generation: hello.binding.generation,
      watchId,
    });
    if (verdict === "deliver") options.onEvent(event.value.event);
  };

  /** The request's result, or undefined when the helper did not answer in time or went away. */
  const request = (
    method: ComputerUseMethod,
    params: unknown,
    deadlineMs: number,
    admitted?: (result: unknown) => void,
  ) =>
    new Promise<unknown>((resolve) => {
      if (closed || hello === undefined) return resolve(undefined);
      const id = options.newId();
      const cancel = options.after(deadlineMs, () => settle(id, undefined));
      pending.set(id, { resolve, cancel, ...(admitted ? { admitted } : {}) });
      options.write(
        JSON.stringify({
          id,
          generation: hello.binding.generation,
          method,
          deadlineMs,
          params,
        }) + "\n",
      );
    });

  return {
    start: () => {
      options.write(JSON.stringify({ clientApiVersion: COMPUTER_USE_PROTOCOL_VERSION }) + "\n");
      return helloWaiter.promise;
    },
    line,
    request: (method: ComputerUseMethod, params: unknown, deadlineMs: number) =>
      request(method, params, deadlineMs),
    /**
     * Watches these windows. The new watch takes over as its answer is read, before the line
     * after it: until then events of the old one (its clearing active:false among them) count,
     * and from then the new one's initial states, which can follow in the same chunk.
     */
    watch: async (targets: ReadonlyArray<ComputerUseWindowTarget>, deadlineMs: number) => {
      const next = options.newId();
      const accepts = (result: unknown) =>
        typeof result === "object" &&
        result !== null &&
        "watchId" in result &&
        result.watchId === next;
      const result = await request("watch", { watchId: next, targets }, deadlineMs, (answer) => {
        if (accepts(answer)) watchId = next;
      });
      return accepts(result);
    },
    unwatch: async (deadlineMs: number) => {
      // A refused unwatch leaves the helper watching: its events, clearing ones among them,
      // still count until an unwatch is acknowledged.
      const acknowledged = (result: unknown) =>
        typeof result === "object" && result !== null && !("outcome" in result);
      const result = await request("unwatch", {}, deadlineMs, (answer) => {
        if (acknowledged(answer)) watchId = undefined;
      });
      return acknowledged(result);
    },
    watching: () => watchId !== undefined,
    close,
  };
}

export type HelperClient = ReturnType<typeof makeHelperClient>;
