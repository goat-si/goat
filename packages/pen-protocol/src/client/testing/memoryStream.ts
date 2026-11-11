// An in-memory PenStream pair for adapter tests: the test plays the server end directly, with no Noise or relay.
import { concatBytes } from "../bytes.ts";
import { PenError } from "../errors.ts";
import type { PenStream, PenStreamStats } from "../stream.ts";

interface Pipe {
  chunks: Array<Uint8Array>;
  ended: boolean;
  waiters: Array<() => void>;
}

const pipe = (): Pipe => ({ chunks: [], ended: false, waiters: [] });
const wake = (p: Pipe) => {
  for (const w of p.waiters.splice(0)) w();
};

async function readFrom(p: Pipe, closed: () => number | undefined): Promise<Uint8Array | null> {
  for (;;) {
    const chunk = p.chunks.shift();
    if (chunk !== undefined) return chunk;
    if (p.ended) return null;
    const code = closed();
    if (code !== undefined)
      throw new PenError("stream-closed", "closed " + code, { closeCode: code });
    await new Promise<void>((resolve) => p.waiters.push(resolve));
  }
}

export function memoryStreamPair() {
  const toServer = pipe();
  const toClient = pipe();
  let closeCode: number | undefined;
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const closeWith = (code: number) => {
    if (closeCode !== undefined) return;
    closeCode = code;
    resolveClosed(code);
    wake(toServer);
    wake(toClient);
  };
  const client: PenStream = {
    write: async (bytes) => {
      if (closeCode !== undefined) throw new PenError("stream-closed", "closed", { closeCode });
      toServer.chunks.push(bytes.slice());
      wake(toServer);
    },
    end: () => {
      toServer.ended = true;
      wake(toServer);
    },
    read: () => readFrom(toClient, () => closeCode),
    close: closeWith,
    closed,
    stats: (): PenStreamStats => ({ buffered: 0, capacity: 0, uncredited: 0, inflight: 0 }),
  };
  return {
    client,
    server: {
      write: (bytes: Uint8Array | string) => {
        toClient.chunks.push(
          typeof bytes === "string" ? Uint8Array.from(bytes, (c) => c.charCodeAt(0)) : bytes,
        );
        wake(toClient);
      },
      end: () => {
        toClient.ended = true;
        wake(toClient);
      },
      close: closeWith,
      /** Everything the client has written so far, as one buffer. */
      written: () => concatBytes(...toServer.chunks),
      /** Resolves once the client has written at least n bytes. */
      whenWritten: async (n: number) => {
        while (toServer.chunks.reduce((sum, c) => sum + c.length, 0) < n) {
          await new Promise<void>((resolve) => toServer.waiters.push(resolve));
        }
      },
      clientEnded: () => toServer.ended,
      closeCode: () => closeCode,
      /** Resolves once the client closed the stream. */
      whenClosed: () => closed.then(() => undefined),
    },
  };
}
