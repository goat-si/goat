// @effect-diagnostics nodeBuiltinImport:off -- A raw X11 socket: one bounded query per check.
// @effect-diagnostics globalTimers:off -- One bounded exchange at a socket callback boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { localDisplayNumber, x11SetupRequest, xauthorityCookie } from "./CuaDisplayCapability.ts";

/**
 * Whether the windows a driver names are on the X display GOAT gave it (#1358). A driver that
 * ended up on another display, such as the person's own signed-in desktop, names windows that
 * do not exist on the intended display, or belong to other processes there; either is "other".
 * Anything that cannot be read is "unknown", which callers treat as other.
 */
export type WindowPlacement = "same" | "other" | "unknown";

export interface NamedWindow {
  readonly pid: number;
  readonly windowId: number;
}

const ASK_TIMEOUT_MS = 2_000;
const INTERN_ATOM = 16;
const GET_PROPERTY = 20;
const GET_GEOMETRY = 14;
const CARDINAL = 6;

const request = (opcode: number, data: number, words: number, fill: (view: DataView) => void) => {
  const bytes = new Uint8Array(words * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = opcode;
  bytes[1] = data;
  view.setUint16(2, words, true);
  fill(view);
  return bytes;
};

/** Replies in order; an error answers its request with undefined, a lost connection all of them. */
function connection(socket: NodeNet.Socket) {
  let buffer = new Uint8Array(0);
  let closed = false;
  let setup: ((reply: Uint8Array | undefined) => void) | undefined;
  const waiting: Array<(reply: Uint8Array | undefined) => void> = [];
  const fail = () => {
    closed = true;
    setup?.(undefined);
    setup = undefined;
    for (const wake of waiting.splice(0)) wake(undefined);
  };
  socket.on("error", fail);
  socket.on("close", fail);
  socket.on("data", (chunk: Buffer) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
    if (setup) {
      if (buffer.length < 8) return;
      const total = 8 + 4 * new DataView(buffer.buffer).getUint16(6, true);
      if (buffer.length < total) return;
      const done = setup;
      setup = undefined;
      const reply = buffer.slice(0, total);
      buffer = buffer.slice(total);
      done(reply);
    }
    for (;;) {
      if (buffer.length < 32) return;
      const kind = buffer[0] ?? 0;
      const length = kind === 1 ? 32 + 4 * new DataView(buffer.buffer).getUint32(4, true) : 32;
      if (buffer.length < length) return;
      const message = buffer.slice(0, length);
      buffer = buffer.slice(length);
      // Every request here expects a reply, so an error answers the oldest waiting one.
      if (kind === 0) waiting.shift()?.(undefined);
      else if (kind === 1) waiting.shift()?.(message);
    }
  });
  return {
    start: (bytes: Uint8Array) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        if (closed) return resolve(undefined);
        setup = resolve;
        socket.write(bytes);
      }),
    ask: (bytes: Uint8Array) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        if (closed) return resolve(undefined);
        waiting.push(resolve);
        socket.write(bytes);
      }),
  };
}

/** Checks named windows against one X display, given as the DISPLAY and XAUTHORITY GOAT chose. */
export function makeX11WindowPlacement(
  display: { readonly DISPLAY: string; readonly XAUTHORITY?: string | undefined },
  /** For tests: a scripted server's socket. */
  socketPath?: string,
) {
  return async (windows: ReadonlyArray<NamedWindow>): Promise<WindowPlacement> => {
    if (windows.length === 0) return "same";
    const number = localDisplayNumber(display.DISPLAY);
    if (number === null) return "unknown";
    const authFile = display.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
    const cookie = await NodeFSP.readFile(authFile).then(
      (bytes) => xauthorityCookie(bytes, number),
      () => null,
    );
    const socket = NodeNet.createConnection(socketPath ?? "/tmp/.X11-unix/X" + number);
    const timer = setTimeout(() => socket.destroy(), ASK_TIMEOUT_MS);
    try {
      return await place(connection(socket), cookie, windows);
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  };
}

async function place(
  x: ReturnType<typeof connection>,
  cookie: Uint8Array | null,
  windows: ReadonlyArray<NamedWindow>,
): Promise<WindowPlacement> {
  const setup = await x.start(x11SetupRequest(cookie));
  if (!setup || setup[0] !== 1) return "unknown";
  const name = new TextEncoder().encode("_NET_WM_PID");
  const interned = await x.ask(
    request(INTERN_ATOM, 1, 2 + Math.ceil(name.length / 4), (view) => {
      view.setUint16(4, name.length, true);
      name.forEach((byte, index) => view.setUint8(8 + index, byte));
    }),
  );
  if (!interned) return "unknown";
  const pidAtom = new DataView(interned.buffer).getUint32(8, true);
  // Window ids repeat across X servers (the first client window is often 0x200003 on each), so a
  // window existing here proves nothing alone: only its _NET_WM_PID matching does.
  let proven = 0;
  for (const window of windows) {
    // A window this display does not have is another display's.
    const geometry = await x.ask(
      request(GET_GEOMETRY, 0, 2, (view) => view.setUint32(4, window.windowId, true)),
    );
    if (!geometry) return "other";
    if (pidAtom === 0) return "unknown";
    const property = await x.ask(
      request(GET_PROPERTY, 0, 6, (view) => {
        view.setUint32(4, window.windowId, true);
        view.setUint32(8, pidAtom, true);
        view.setUint32(12, CARDINAL, true);
        view.setUint32(16, 0, true);
        view.setUint32(20, 1, true);
      }),
    );
    if (!property) return "other";
    const view = new DataView(property.buffer);
    // A window that names no pid proves nothing either way; one that names another is elsewhere.
    if (property[1] !== 32 || view.getUint32(16, true) < 1) continue;
    if (view.getUint32(32, true) !== window.pid) return "other";
    proven++;
  }
  return proven > 0 ? "same" : "unknown";
}
