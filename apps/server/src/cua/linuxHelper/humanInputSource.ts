// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; X11 needs a raw socket.
// @effect-diagnostics globalTimers:off -- Request deadlines at socket callback boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ComputerUseHumanInputSource } from "@goat/contracts";

import { localDisplayNumber, x11SetupRequest, xauthorityCookie } from "../CuaDisplayCapability.ts";

/**
 * A person's keyboard and pointer input on an X display, from XInput2 raw events (WS10 #1138,
 * #1235). Every raw event names the device it came from, so the helper's own input is told
 * apart by device, not by time: XTEST devices (which the driver's virtual masters use) and any
 * device created after this source opened (the driver's uinput devices, made later) are never
 * the person. Only that an event happened is kept; never which key or where.
 *
 * A keyboard plugged in after the helper started is not watched until the helper restarts.
 */

export interface HumanInput {
  readonly at: number;
  readonly source: Exclude<ComputerUseHumanInputSource, "unknown">;
}

export interface HumanInputSource {
  /** The latest input from a person's device, if any since the source opened. */
  readonly latest: () => HumanInput | undefined;
  /** True once the connection broke: the source sees nothing more. */
  readonly lost: () => boolean;
  readonly close: () => void;
}

const pad4 = (length: number) => (4 - (length % 4)) % 4;
const ASK_TIMEOUT_MS = 2_000;
const GENERIC_EVENT = 35;
const XI_RAW_KEY_PRESS = 13;
const XI_RAW_BUTTON_PRESS = 15;
const XI_RAW_MOTION = 17;
// XIDeviceInfo.use: slave pointer, slave keyboard, floating slave.
const SLAVE_USES = new Set([3, 4, 5]);

/** The first screen's root window from an X connection setup reply (little-endian). */
export function setupRoot(reply: Uint8Array): number | undefined {
  if (reply[0] !== 1 || reply.byteLength < 40) return undefined;
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const vendorLength = view.getUint16(24, true);
  const formats = reply[29] ?? 0;
  const screens = 40 + vendorLength + pad4(vendorLength) + formats * 8;
  return screens + 4 <= reply.byteLength ? view.getUint32(screens, true) : undefined;
}

function request(bytes: number, fill: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  view.setUint16(2, bytes / 4, true);
  fill(view);
  return out;
}

const queryExtension = (name: string) => {
  const encoded = new TextEncoder().encode(name);
  const out = request(8 + encoded.length + pad4(encoded.length), (view) => {
    view.setUint8(0, 98);
    view.setUint16(4, encoded.length, true);
  });
  out.set(encoded, 8);
  return out;
};
const xiQueryVersion = (major: number) =>
  request(8, (view) => {
    view.setUint8(0, major);
    view.setUint8(1, 47);
    view.setUint16(4, 2, true);
    view.setUint16(6, 2, true);
  });
// deviceid 0: XIAllDevices.
const xiQueryDevice = (major: number) =>
  request(8, (view) => {
    view.setUint8(0, major);
    view.setUint8(1, 48);
  });
/** Raw key, button and motion events from every device, on the root window. */
export const xiSelectRawEvents = (major: number, root: number) =>
  request(20, (view) => {
    view.setUint8(0, major);
    view.setUint8(1, 46);
    view.setUint32(4, root, true);
    view.setUint16(8, 1, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 1, true);
    view.setUint32(
      16,
      (1 << XI_RAW_KEY_PRESS) | (1 << XI_RAW_BUTTON_PRESS) | (1 << XI_RAW_MOTION),
      true,
    );
  });

export interface XiDevice {
  readonly id: number;
  readonly use: number;
  readonly name: string;
}

/** The devices in an XIQueryDevice reply. */
export function parseDevices(reply: Uint8Array): ReadonlyArray<XiDevice> {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const count = view.getUint16(8, true);
  const devices: XiDevice[] = [];
  let at = 32;
  for (let index = 0; index < count && at + 12 <= reply.byteLength; index++) {
    const id = view.getUint16(at, true);
    const use = view.getUint16(at + 2, true);
    const classes = view.getUint16(at + 6, true);
    const nameLength = view.getUint16(at + 8, true);
    const name = new TextDecoder().decode(reply.subarray(at + 12, at + 12 + nameLength));
    at += 12 + nameLength + pad4(nameLength);
    for (let klass = 0; klass < classes && at + 4 <= reply.byteLength; klass++)
      at += 4 * view.getUint16(at + 2, true);
    devices.push({ id, use, name });
  }
  return devices;
}

/** The person's devices: slaves that are not XTEST. */
export const personDevices = (devices: ReadonlyArray<XiDevice>) =>
  new Set(
    devices
      .filter((device) => SLAVE_USES.has(device.use) && !/xtest/iu.test(device.name))
      .map((device) => device.id),
  );

/** What kind of input a raw event is, and from which device; undefined for anything else. */
export function parseRawEvent(
  message: Uint8Array,
  major: number,
): { readonly source: HumanInput["source"]; readonly device: number } | undefined {
  if (((message[0] ?? 0) & 0x7f) !== GENERIC_EVENT || message[1] !== major) return undefined;
  if (message.byteLength < 22) return undefined;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const type = view.getUint16(8, true);
  const source =
    type === XI_RAW_KEY_PRESS
      ? "keyboard"
      : type === XI_RAW_BUTTON_PRESS || type === XI_RAW_MOTION
        ? "pointer"
        : undefined;
  return source === undefined ? undefined : { source, device: view.getUint16(20, true) };
}

/** Bytes one X server message takes: 32, plus the extra length of a reply or generic event. */
const messageLength = (bytes: Uint8Array) => {
  const code = (bytes[0] ?? 0) & 0x7f;
  return code === 1 || code === GENERIC_EVENT
    ? 32 + 4 * new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
    : 32;
};

/** Opens the display's input watch, or undefined when the display or XInput2 is missing. */
export async function openX11HumanInput(
  environment: { readonly DISPLAY?: string | undefined; readonly XAUTHORITY?: string | undefined },
  now: () => number,
): Promise<HumanInputSource | undefined> {
  const display = localDisplayNumber(environment.DISPLAY);
  if (display === null) return undefined;
  const authFile = environment.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
  const cookie = await NodeFSP.readFile(authFile).then(
    (bytes) => xauthorityCookie(bytes, display),
    () => null,
  );
  const socket = NodeNet.createConnection("/tmp/.X11-unix/X" + display);
  let buffer = new Uint8Array(0);
  let closed = false;
  let latest: HumanInput | undefined;
  let watching: { readonly major: number; readonly devices: ReadonlySet<number> } | undefined;
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
      const code = (message[0] ?? 0) & 0x7f;
      // Replies (1) and errors (0) answer requests in order; events report input.
      if (code <= 1) {
        waiting.shift()?.(message);
        continue;
      }
      if (!watching) continue;
      const raw = parseRawEvent(message, watching.major);
      if (raw && watching.devices.has(raw.device)) latest = { at: now(), source: raw.source };
    }
  });
  const reply = await new Promise<Uint8Array | undefined>((resolve) => {
    setup = resolve;
    socket.once("connect", () => socket.write(x11SetupRequest(cookie)));
    setTimeout(() => resolve(undefined), ASK_TIMEOUT_MS).unref();
  });
  const root = reply ? setupRoot(reply) : undefined;
  // A request left unanswered puts the queue out of step with the replies, so it closes.
  const ask = (bytes: Uint8Array) =>
    new Promise<Uint8Array | undefined>((resolve) => {
      if (closed) return resolve(undefined);
      const timer = setTimeout(() => {
        close();
        resolve(undefined);
      }, ASK_TIMEOUT_MS);
      timer.unref();
      waiting.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
      socket.write(bytes);
    });
  const fail = () => {
    close();
    return undefined;
  };
  if (root === undefined) return fail();
  const extension = await ask(queryExtension("XInputExtension"));
  if (!extension || extension[0] !== 1 || extension[8] !== 1) return fail();
  const major = extension[9] ?? 0;
  const version = await ask(xiQueryVersion(major));
  if (!version || version[0] !== 1) return fail();
  const versionView = new DataView(version.buffer, version.byteOffset, version.byteLength);
  if (versionView.getUint16(8, true) < 2) return fail();
  const list = await ask(xiQueryDevice(major));
  if (!list || list[0] !== 1) return fail();
  const devices = personDevices(parseDevices(list));
  // Select has no reply; a second query after it proves the server took it without an error.
  socket.write(xiSelectRawEvents(major, root));
  const synced = await ask(xiQueryVersion(major));
  if (!synced || synced[0] !== 1) return fail();
  watching = { major, devices };
  return { latest: () => latest, lost: () => closed, close };
}
