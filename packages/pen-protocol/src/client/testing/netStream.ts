// @effect-diagnostics nodeBuiltinImport:off - Wraps a TCP socket as a PenStream for loopback runs (Autobahn, differential).
import type * as NodeNet from "node:net";
import { PenError } from "../errors.ts";
import type { PenStream } from "../stream.ts";

/** A PenStream over a plain TCP socket, so the HTTP and WebSocket adapters can run against real servers. */
export function netStream(socket: NodeNet.Socket): PenStream {
  const chunks: Array<Uint8Array> = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let closeCode: number | undefined;
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  socket.on("data", (data: Buffer) => {
    chunks.push(new Uint8Array(data));
    wake();
  });
  socket.on("end", () => {
    ended = true;
    wake();
  });
  socket.on("close", () => {
    closeCode ??= ended ? 1000 : 1006;
    resolveClosed(closeCode);
    wake();
  });
  socket.on("error", () => undefined);
  return {
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        if (closeCode !== undefined) {
          reject(new PenError("stream-closed", "closed", { closeCode }));
          return;
        }
        socket.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
    end: () => {
      socket.end();
    },
    read: async () => {
      for (;;) {
        const chunk = chunks.shift();
        if (chunk !== undefined) return chunk;
        if (ended) return null;
        if (closeCode !== undefined) throw new PenError("stream-closed", "closed", { closeCode });
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    close: (code) => {
      closeCode ??= code;
      socket.end();
    },
    closed,
    stats: () => ({ buffered: 0, capacity: 0, uncredited: 0, inflight: 0 }),
  };
}
