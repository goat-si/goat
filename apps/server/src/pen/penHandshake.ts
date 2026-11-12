// @effect-diagnostics nodeBuiltinImport:off -- the proof runs on the accepted loopback socket.
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";

import {
  PEN_SERVICE_LINE1_CAP,
  PEN_SERVICE_LINE3_CAP,
  parseServiceHello,
  serviceAnswer,
  verifyServiceIdentity,
} from "@goat/pen-protocol/service";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { PenPeer } from "../auth/connectionContext.ts";

/** GOAT's service name on Pen (pen-protocol CONTRACT "Services"). */
export const PEN_SERVICE_NAME = "goat";

export class PenHandshakeFailed extends Data.TaggedError("PenHandshakeFailed")<{}> {}

export interface PenPin {
  readonly key: Uint8Array;
  readonly meshId: string;
  readonly nodeId: string;
}

/**
 * Reads LF-terminated lines, LF included, of at most `cap` bytes, keeping what follows. The socket
 * flows only while a read waits, so a slow reader holds at most one line beyond the one it reads.
 */
export const lineReader = (socket: NodeStream.Duplex) => {
  let buffered = Buffer.alloc(0);
  let ended = false;
  let waiter: (() => void) | undefined;
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    waiter?.();
  };
  const onEnd = () => {
    ended = true;
    waiter?.();
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  const read = (cap: number) =>
    Effect.callback<Buffer, PenHandshakeFailed>((resume) => {
      const check = () => {
        const lf = buffered.indexOf(0x0a);
        if (lf !== -1 && lf < cap) {
          const line = buffered.subarray(0, lf + 1);
          buffered = buffered.subarray(lf + 1);
          waiter = undefined;
          socket.pause();
          resume(Effect.succeed(line));
        } else if (lf !== -1 || buffered.length >= cap || ended) {
          waiter = undefined;
          resume(Effect.fail(new PenHandshakeFailed()));
        }
      };
      waiter = check;
      check();
      if (waiter !== undefined) socket.resume();
      return Effect.sync(() => {
        waiter = undefined;
      });
    });
  /** Stops reading; the bytes after line 3 belong to the caller's stream. */
  const release = () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.pause();
    return buffered;
  };
  return { read, release };
};

const decode = <A>(run: () => A) => Effect.try({ try: run, catch: () => new PenHandshakeFailed() });

/**
 * The program side of Pen's local delivery: line 1 in, line 2 out, line 3 in, through the shared
 * codec. Any violation fails with nothing written back after line 2. `nonce` is for tests only.
 */
export const proveDelivery = Effect.fn("PenHandshake.proveDelivery")(function* (
  socket: NodeStream.Duplex,
  pin: PenPin,
  nonce: () => Uint8Array = () => NodeCrypto.randomBytes(32),
) {
  const reader = lineReader(socket);
  const line1 = yield* reader.read(PEN_SERVICE_LINE1_CAP);
  const nd = yield* decode(() => parseServiceHello(line1));
  const ng = nonce();
  socket.write(serviceAnswer(pin.key, PEN_SERVICE_NAME, nd, ng));
  const line3 = yield* reader.read(PEN_SERVICE_LINE3_CAP);
  const identity = yield* decode(() =>
    verifyServiceIdentity(line3, {
      key: pin.key,
      name: PEN_SERVICE_NAME,
      nd,
      ng,
      mesh: pin.meshId,
      self: pin.nodeId,
    }),
  );
  const peer: PenPeer = { meshId: identity.mesh, ...identity.caller };
  return { peer, rest: reader.release() };
});
