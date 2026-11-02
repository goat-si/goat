// @effect-diagnostics nodeBuiltinImport:off - Process-level error handlers run outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

/**
 * The only module that listens for process "uncaughtException" and "unhandledRejection"
 * (docs/internals/server-resilience.md). It logs every one; the process keeps running only for the
 * reviewed entries there, and exits 1 for everything else so the desktop restarts the server.
 */

/** Names a rejection its owner knows is harmless, as the line to log; undefined passes it on. */
export type RejectionClassifier = (reason: unknown) => string | undefined;

interface NetState {
  netInstalled: boolean;
  rejectionHolds: number;
  rejectionListening: boolean;
  contained: number;
  readonly classifiers: Set<RejectionClassifier>;
  readonly counts: Map<string, number>;
  readonly onUncaught: (error: unknown) => void;
  readonly onRejection: (reason: unknown) => void;
}

const WS_CLOSED_CONNECTING = "WebSocket was closed before the connection was established";
const STATE_KEY = Symbol.for("goat.processErrorNet");

const stringProperty = (value: object, name: string): string | undefined => {
  const property: unknown = Reflect.get(value, name);
  return typeof property === "string" ? property : undefined;
};

/** Whether Node raised this because an emitter emitted it as 'error' with no listener; a plain throw is unmarked. */
export const isUnheardErrorEvent = (error: unknown): boolean =>
  error instanceof Error &&
  Object.getOwnPropertySymbols(error).some(
    (symbol) => symbol.description === "kEnhanceStackBeforeInspector",
  );

// Each key is a reviewed entry in server-resilience.md; all require an unheard 'error' event.
const teardownKey = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !isUnheardErrorEvent(error)) return undefined;
  const code = stringProperty(error, "code");
  const syscall = stringProperty(error, "syscall");
  if (code === "EPIPE" && syscall === "write") return "EPIPE";
  if (code === "ECONNRESET" && (syscall === "read" || syscall === "write")) return "ECONNRESET";
  if (!("code" in error) && error.message === WS_CLOSED_CONNECTING) return "WS_CLOSED_CONNECTING";
  return undefined;
};

const writeStderr = (text: string) => {
  try {
    NodeFS.writeSync(2, text);
  } catch {
    // stderr may be the pipe that broke; the count still records the event.
  }
};

const errorKey = (error: unknown) => (error instanceof Error ? error.name : typeof error);

const isNetState = (value: unknown): value is NetState =>
  typeof value === "object" && value !== null && "classifiers" in value && "onRejection" in value;

const makeState = (): NetState => {
  const net: NetState = {
    netInstalled: false,
    rejectionHolds: 0,
    rejectionListening: false,
    contained: 0,
    classifiers: new Set(),
    counts: new Map(),
    onUncaught: (error) => {
      const key = teardownKey(error);
      if (key !== undefined) return contain(net, key, NodeUtil.inspect(error));
      log(net, "fatal uncaught exception", errorKey(error), NodeUtil.inspect(error));
      process.exit(1);
    },
    onRejection: (reason) => {
      for (const classify of net.classifiers) {
        const message = classify(reason);
        if (message !== undefined) return contain(net, "rejection", message);
      }
      // Node's rule: with another listener present, that listener decides.
      if (process.listenerCount("unhandledRejection") > 1) {
        return log(
          net,
          "unhandled rejection left to another listener",
          errorKey(reason),
          NodeUtil.inspect(reason),
        );
      }
      log(net, "fatal unhandled rejection", errorKey(reason), NodeUtil.inspect(reason));
      process.exit(1);
    },
  };
  return net;
};

const log = (net: NetState, verdict: string, key: string, detail: string) => {
  const count = (net.counts.get(key) ?? 0) + 1;
  net.counts.set(key, count);
  writeStderr(`goat: ${verdict} ${key} (${count}): ${detail}\n`);
};

const contain = (net: NetState, key: string, detail: string) => {
  net.contained += 1;
  log(net, "contained", key, detail);
};

// One state per process, even if this module is loaded twice (source and bundle).
const state = (): NetState => {
  const existing: unknown = Reflect.get(globalThis, STATE_KEY);
  if (isNetState(existing)) return existing;
  const created = makeState();
  Reflect.set(globalThis, STATE_KEY, created);
  return created;
};

const listenForRejections = (net: NetState) => {
  if (net.rejectionListening) return;
  net.rejectionListening = true;
  process.on("unhandledRejection", net.onRejection);
};

/** Installs both handlers for the rest of the process; shutdown is when teardown errors cluster. */
export function installProcessErrorNet(): void {
  const net = state();
  if (net.netInstalled) return;
  net.netInstalled = true;
  process.on("uncaughtException", net.onUncaught);
  listenForRejections(net);
}

/** Contains the rejections the classifier names until released; uncaught exceptions stay Node's. */
export function containRejections(classify: RejectionClassifier): () => void {
  const net = state();
  net.classifiers.add(classify);
  net.rejectionHolds += 1;
  listenForRejections(net);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    net.classifiers.delete(classify);
    net.rejectionHolds -= 1;
    if (net.rejectionHolds === 0 && !net.netInstalled && net.rejectionListening) {
      net.rejectionListening = false;
      process.off("unhandledRejection", net.onRejection);
    }
  };
}

/** How many errors the net has kept from ending the process since it started. */
export const containedErrorCount = (): number => state().contained;
