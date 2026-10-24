// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; X11 needs a raw socket.
// @effect-diagnostics globalTimers:off -- A connect deadline at a socket callback boundary.
import * as NodeFS from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { localDisplayNumber, x11SetupRequest, xauthorityCookie } from "../CuaDisplayCapability.ts";

/**
 * How long ago a person last touched the keyboard or pointer on an X display, from the
 * MIT-SCREEN-SAVER extension (WS10 #1138, #1235). It is the X server's own idle counter, so it
 * needs no input device access and records nothing about what was typed. XWayland reports only
 * input to X clients, so GNOME Wayland uses Mutter's idle monitor instead (openGnomeIdle).
 */

export interface IdleSource {
  /** Milliseconds since the last input, or undefined when the source stopped answering. */
  readonly idleMs: () => Promise<number | undefined>;
  readonly close: () => void;
}

const pad4 = (length: number) => (4 - (length % 4)) % 4;

/** The first screen's root window from an X connection setup reply (little-endian). */
export function setupRoot(reply: Uint8Array): number | undefined {
  if (reply[0] !== 1 || reply.byteLength < 40) return undefined;
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const vendorLength = view.getUint16(24, true);
  const formats = reply[29] ?? 0;
  const screens = 40 + vendorLength + pad4(vendorLength) + formats * 8;
  return screens + 4 <= reply.byteLength ? view.getUint32(screens, true) : undefined;
}

/** A QueryExtension request for name. */
export function queryExtensionRequest(name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const request = new Uint8Array(8 + encoded.length + pad4(encoded.length));
  const view = new DataView(request.buffer);
  request[0] = 98;
  view.setUint16(2, request.length / 4, true);
  view.setUint16(4, encoded.length, true);
  request.set(encoded, 8);
  return request;
}

/** ScreenSaverQueryInfo (minor 1) on a drawable. */
export function screenSaverQueryInfoRequest(major: number, drawable: number): Uint8Array {
  const request = new Uint8Array(8);
  const view = new DataView(request.buffer);
  request[0] = major;
  request[1] = 1;
  view.setUint16(2, 2, true);
  view.setUint32(4, drawable, true);
  return request;
}

/** Bytes an X server message takes: 32, plus a reply's extra length. */
const messageLength = (bytes: Uint8Array) =>
  bytes[0] === 1
    ? 32 + 4 * new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
    : 32;

/** Opens the display's idle counter, or undefined when the display or extension is missing. */
export async function openX11Idle(environment: {
  readonly DISPLAY?: string | undefined;
  readonly XAUTHORITY?: string | undefined;
}): Promise<IdleSource | undefined> {
  const display = localDisplayNumber(environment.DISPLAY);
  if (display === null) return undefined;
  const authFile = environment.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
  const cookie = await NodeFS.readFile(authFile).then(
    (bytes) => xauthorityCookie(bytes, display),
    () => null,
  );
  const socket = NodeNet.createConnection("/tmp/.X11-unix/X" + display);
  let buffer = new Uint8Array(0);
  let closed = false;
  const waiting: Array<(message: Uint8Array | undefined) => void> = [];
  let setup: ((reply: Uint8Array | undefined) => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    setup?.(undefined);
    for (const wake of waiting.splice(0)) wake(undefined);
  };
  socket.on("error", close);
  socket.on("close", close);
  socket.on("data", (chunk: Buffer) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
    if (setup) {
      if (buffer.length < 8) return;
      const total = 8 + 4 * new DataView(buffer.buffer).getUint16(6, true);
      if (buffer.length < total) return;
      const reply = buffer.slice(0, total);
      buffer = buffer.slice(total);
      const done = setup;
      setup = undefined;
      done(reply);
    }
    while (buffer.length >= 32 && buffer.length >= messageLength(buffer)) {
      const length = messageLength(buffer);
      const message = buffer.slice(0, length);
      buffer = buffer.slice(length);
      // Events (codes above 1) are not ours; only replies and errors answer requests.
      if ((message[0] ?? 2) <= 1) waiting.shift()?.(message);
    }
  });
  const reply = await new Promise<Uint8Array | undefined>((resolve) => {
    setup = resolve;
    socket.once("connect", () => socket.write(x11SetupRequest(cookie)));
    setTimeout(() => resolve(undefined), 2_000).unref();
  });
  const root = reply ? setupRoot(reply) : undefined;
  if (root === undefined) {
    close();
    return undefined;
  }
  // Requests are answered in order, one at a time here.
  const ask = (request: Uint8Array) =>
    new Promise<Uint8Array | undefined>((resolve) => {
      if (closed) return resolve(undefined);
      waiting.push(resolve);
      socket.write(request);
    });
  const extension = await ask(queryExtensionRequest("MIT-SCREEN-SAVER"));
  if (!extension || extension[0] !== 1 || extension[8] !== 1) {
    close();
    return undefined;
  }
  const major = extension[9] ?? 0;
  return {
    idleMs: async () => {
      const info = await ask(screenSaverQueryInfoRequest(major, root));
      if (!info || info[0] !== 1) return undefined;
      return new DataView(info.buffer, info.byteOffset, info.byteLength).getUint32(16, true);
    },
    close,
  };
}

/** `(uint64 N,)` from org.gnome.Mutter.IdleMonitor.GetIdletime. */
export const parseUint64 = (output: string): number | undefined => {
  const match = /\(uint64 (\d+),\)/u.exec(output);
  return match ? Number(match[1]) : undefined;
};

/**
 * Mutter's own idle counter on the session bus, for GNOME on Wayland where no X server sees
 * the person's input. Undefined when it does not answer.
 */
export async function openGnomeIdle(
  run: (args: ReadonlyArray<string>) => Promise<string>,
): Promise<IdleSource | undefined> {
  const ask = () =>
    run([
      "call",
      "--session",
      "--dest",
      "org.gnome.Mutter.IdleMonitor",
      "--object-path",
      "/org/gnome/Mutter/IdleMonitor/Core",
      "--method",
      "org.gnome.Mutter.IdleMonitor.GetIdletime",
    ]).then(parseUint64, () => undefined);
  return (await ask()) === undefined ? undefined : { idleMs: ask, close: () => undefined };
}
