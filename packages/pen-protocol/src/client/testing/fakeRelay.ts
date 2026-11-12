// In-memory relay sockets for tests: the test opens, feeds and closes each socket by hand, so nothing waits on time.
import type { RelaySocketEvent, RelaySocketFactory, RelaySocketLike } from "../relayClient.ts";

type Listener = (event: RelaySocketEvent) => void;

export class FakeSocket implements RelaySocketLike {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  extensions: string | undefined = undefined;
  readonly sent: Array<Uint8Array | string> = [];
  readonly url: string;
  closedWith: number | null | undefined = undefined;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #watchers: Array<() => void> = [];

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array | string): void {
    if (this.readyState !== 1) throw new Error("INVALID_STATE_ERR");
    this.sent.push(typeof data === "string" ? data : data.slice());
    this.#wake();
  }

  close(code?: number): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = code ?? null;
    this.readyState = 2;
    this.#wake();
  }

  // Test controls.
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }

  receive(data: Uint8Array | string): void {
    this.#emit("message", { data: typeof data === "string" ? data : data.slice().buffer });
  }

  remoteClose(code: number): void {
    this.readyState = 3;
    this.#emit("close", { code });
  }

  /** The socket reports an error, as a refused or broken connection does. */
  fail(): void {
    this.#emit("error", {});
  }

  binarySent(): Array<Uint8Array> {
    return this.sent.filter((item): item is Uint8Array => typeof item !== "string");
  }

  textSent(): Array<string> {
    return this.sent.filter((item): item is string => typeof item === "string");
  }

  /** Resolves once this socket has sent `count` messages, binary or text. */
  whenSent(count: number): Promise<void> {
    return this.#until(() => this.sent.length >= count);
  }

  /** Resolves once the client has closed this socket. */
  whenClosed(): Promise<void> {
    return this.#until(() => this.closedWith !== undefined);
  }

  #until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (done()) resolve();
        else this.#watchers.push(check);
      };
      this.#watchers.push(check);
    });
  }

  #wake(): void {
    for (const check of this.#watchers.splice(0)) check();
  }

  #emit(type: string, event: RelaySocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export function fakeFactory() {
  const sockets: Array<FakeSocket> = [];
  const waiters: Array<() => void> = [];
  const factory: RelaySocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    for (const wake of waiters.splice(0)) wake();
    return socket;
  };
  return {
    factory,
    sockets,
    /** The socket dialled for relay origin, once it exists. */
    socketFor(origin: string): FakeSocket {
      const socket = sockets.find((s) => s.url.startsWith(origin + "/"));
      if (socket === undefined) throw new Error("no socket for " + origin);
      return socket;
    },
    /** Resolves with the nth socket (1-based) once it has been created. */
    whenSocket(n: number): Promise<FakeSocket> {
      return new Promise((resolve) => {
        const check = () => {
          const socket = sockets[n - 1];
          if (socket !== undefined) resolve(socket);
          else waiters.push(check);
        };
        check();
      });
    },
  };
}
