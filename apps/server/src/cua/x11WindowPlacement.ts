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
 * do not exist on the intended display, belong to other processes there, or sit elsewhere on it;
 * any of those is "other". A window whose owner cannot be read is "unknown", and so is the whole
 * answer: callers never act on it.
 *
 * Window ids repeat across X servers, and one process can hold windows on two of them, so the
 * owner alone is not proof either; the position and size the driver reported must match too.
 */
export type WindowPlacement = "same" | "other" | "unknown";

export interface NamedWindow {
  readonly pid: number;
  readonly windowId: number;
  /** Root coordinates and size, as list_windows reports them. */
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

const ASK_TIMEOUT_MS = 2_000;
const INTERN_ATOM = 16;
const GET_PROPERTY = 20;
const GET_GEOMETRY = 14;
const TRANSLATE_COORDINATES = 40;
const QUERY_EXTENSION = 98;
const CARDINAL = 6;
/** X-Resource QueryClientIds' LocalClientPID: the server's own record of a local client's pid. */
const LOCAL_CLIENT_PID = 2;

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
  const setupView = new DataView(setup.buffer);
  // The first screen's root follows the vendor string and pixmap formats.
  const vendorLength = setupView.getUint16(24, true);
  const formats = setup[29] ?? 0;
  const rootAt = 40 + 4 * Math.ceil(vendorLength / 4) + 8 * formats;
  if (rootAt + 4 > setup.length) return "unknown";
  const root = setupView.getUint32(rootAt, true);
  const named = (name: string) => {
    const bytes = new TextEncoder().encode(name);
    return (opcode: number, data: number) =>
      request(opcode, data, 2 + Math.ceil(bytes.length / 4), (view) => {
        view.setUint16(4, bytes.length, true);
        bytes.forEach((byte, index) => view.setUint8(8 + index, byte));
      });
  };
  const interned = await x.ask(named("_NET_WM_PID")(INTERN_ATOM, 1));
  if (!interned) return "unknown";
  const pidAtom = new DataView(interned.buffer).getUint32(8, true);
  const xres = await resourceExtension(x, named("X-Resource")(QUERY_EXTENSION, 0));
  let unknown = false;
  for (const window of windows) {
    // A window this display does not have is another display's.
    const geometry = await x.ask(
      request(GET_GEOMETRY, 0, 2, (view) => view.setUint32(4, window.windowId, true)),
    );
    if (!geometry) return "other";
    if (window.bounds !== undefined) {
      const origin = await x.ask(
        request(TRANSLATE_COORDINATES, 0, 4, (view) => {
          view.setUint32(4, window.windowId, true);
          view.setUint32(8, root, true);
        }),
      );
      if (!origin) return "unknown";
      const g = new DataView(geometry.buffer);
      const o = new DataView(origin.buffer);
      if (
        o.getInt16(12, true) !== window.bounds.x ||
        o.getInt16(14, true) !== window.bounds.y ||
        g.getUint16(16, true) !== window.bounds.width ||
        g.getUint16(18, true) !== window.bounds.height
      )
        return "other";
    }
    const owner = await ownerPid(x, pidAtom, xres, window.windowId);
    if (owner === undefined) unknown = true;
    else if (owner !== window.pid) return "other";
  }
  return unknown ? "unknown" : "same";
}

/** X-Resource's major opcode when the server has QueryClientIds (1.2 and later). */
async function resourceExtension(
  x: ReturnType<typeof connection>,
  query: Uint8Array,
): Promise<number | undefined> {
  const extension = await x.ask(query);
  if (!extension || extension[8] !== 1) return undefined;
  const major = extension[9] ?? 0;
  const version = await x.ask(
    request(major, 0, 2, (view) => {
      view.setUint8(4, 1);
      view.setUint8(5, 2);
    }),
  );
  if (!version) return undefined;
  const view = new DataView(version.buffer);
  const [serverMajor, serverMinor] = [view.getUint16(8, true), view.getUint16(10, true)];
  return serverMajor > 1 || (serverMajor === 1 && serverMinor >= 2) ? major : undefined;
}

/**
 * The pid owning a window the way the driver reads it: _NET_WM_PID, else the X server's own
 * record of the client that created it. Undefined when neither answers.
 */
async function ownerPid(
  x: ReturnType<typeof connection>,
  pidAtom: number,
  xres: number | undefined,
  windowId: number,
): Promise<number | undefined> {
  if (pidAtom !== 0) {
    const property = await x.ask(
      request(GET_PROPERTY, 0, 6, (view) => {
        view.setUint32(4, windowId, true);
        view.setUint32(8, pidAtom, true);
        view.setUint32(12, CARDINAL, true);
        view.setUint32(16, 0, true);
        view.setUint32(20, 1, true);
      }),
    );
    if (!property) return undefined;
    const view = new DataView(property.buffer);
    if (property[1] === 32 && view.getUint32(16, true) >= 1) return view.getUint32(32, true);
  }
  if (xres === undefined) return undefined;
  const ids = await x.ask(
    request(xres, 4, 4, (view) => {
      view.setUint32(4, 1, true);
      view.setUint32(8, windowId, true);
      view.setUint32(12, LOCAL_CLIENT_PID, true);
    }),
  );
  if (!ids) return undefined;
  const view = new DataView(ids.buffer);
  let at = 32;
  for (let index = 0; index < view.getUint32(8, true) && at + 12 <= ids.length; index++) {
    const mask = view.getUint32(at + 4, true);
    const length = view.getUint32(at + 8, true);
    if (mask === LOCAL_CLIENT_PID && length >= 4 && at + 16 <= ids.length)
      return view.getUint32(at + 12, true);
    at += 12 + length;
  }
  return undefined;
}
