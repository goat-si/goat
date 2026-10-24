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
 * #1235). Every raw event names the device it came from (XI 2.1 and later), so the helper's own
 * input is told apart by device, not by time. Cua Driver names every device it creates "CUA …"
 * (its MPX masters, and their uinput and XTEST slaves; mpx_owner.rs and input/mod.rs at
 * cua-driver-rs-v0.37.0), and XTEST devices carry synthetic input, so neither is the person.
 * Every other slave device is. The device list is read again whenever devices come and go,
 * since ids are reused; input from a device not yet classified waits for that read. Only that
 * an event happened is kept; never which key or where.
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
const XI_HIERARCHY_CHANGED = 11;
// XIDeviceInfo.use: slave pointer, slave keyboard, floating slave.
const SLAVE_USES = new Set([3, 4, 5]);

/** The first screen's root window from an X connection setup reply (little-endian). */
function setupRoot(reply: Uint8Array): number | undefined {
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
/** Raw key, button and motion events from every device, and device changes, on the root. */
const xiSelectRawEvents = (major: number, root: number) =>
  request(20, (view) => {
    view.setUint8(0, major);
    view.setUint8(1, 46);
    view.setUint32(4, root, true);
    view.setUint16(8, 1, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 1, true);
    view.setUint32(
      16,
      (1 << XI_HIERARCHY_CHANGED) |
        (1 << XI_RAW_KEY_PRESS) |
        (1 << XI_RAW_BUTTON_PRESS) |
        (1 << XI_RAW_MOTION),
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

/** Whether a device carries a person's input: a slave that is neither XTEST nor Cua Driver's. */
const isPersonDevice = (device: XiDevice) =>
  SLAVE_USES.has(device.use) && !/xtest/iu.test(device.name) && !device.name.startsWith("CUA ");

/** Every device by id, as the person's or not. */
export const classifyDevices = (devices: ReadonlyArray<XiDevice>) =>
  new Map(devices.map((device) => [device.id, isPersonDevice(device)]));

/** XIHierarchyInfo flags that change which device an id names: master or slave added or removed. */
const IDENTITY_FLAGS = 0x1 | 0x2 | 0x4 | 0x8;

/**
 * For an XI2 hierarchy event, the ids it added or removed, or "all" when its infos cannot be
 * read; undefined for any other message.
 */
export function hierarchyChange(
  message: Uint8Array,
  major: number,
): ReadonlySet<number> | "all" | undefined {
  if (((message[0] ?? 0) & 0x7f) !== GENERIC_EVENT || message[1] !== major) return undefined;
  if (message.byteLength < 32) return undefined;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  if (view.getUint16(8, true) !== XI_HIERARCHY_CHANGED) return undefined;
  const count = view.getUint16(20, true);
  if (32 + 12 * count > message.byteLength) return "all";
  const ids = new Set<number>();
  for (let index = 0; index < count; index++) {
    const at = 32 + 12 * index;
    if ((view.getUint32(at + 8, true) & IDENTITY_FLAGS) !== 0) ids.add(view.getUint16(at, true));
  }
  return ids;
}

/**
 * Which device an input came from, across device changes (XI2 reuses ids). Every change is
 * numbered with the ids it added or removed. Input remembers the change it arrived after, and a
 * device list remembers the change it was read after. A list decides an input only if no change
 * between the two touched the input's id; otherwise, or when the list does not have the id at
 * all, the input counts as a person's, since it cannot be shown not to be.
 */
export function makeDeviceLedger() {
  let changes = 0;
  const touched = new Map<number, ReadonlySet<number> | "all">();
  let list: { readonly covers: number; readonly devices: ReadonlyMap<number, boolean> } | undefined;
  let held: Array<{
    readonly device: number;
    readonly change: number;
    readonly input: HumanInput;
  }> = [];
  const touchedBetween = (after: number, upTo: number, device: number) => {
    for (let change = after + 1; change <= upTo; change++) {
      const ids = touched.get(change);
      if (ids === "all" || ids?.has(device)) return true;
    }
    return false;
  };
  return {
    changes: () => changes,
    /** A hierarchy change, with the ids it added or removed. */
    change: (ids: ReadonlySet<number> | "all") => {
      changes++;
      touched.set(changes, ids);
    },
    /** Input as it arrives: counted, dropped, or held for a list that covers it. */
    input: (device: number, input: HumanInput): "person" | "drop" | "held" => {
      const person = list?.covers === changes ? list.devices.get(device) : undefined;
      if (person === true) return "person";
      if (person === false) return "drop";
      held.push({ device, change: changes, input });
      return "held";
    },
    /** A device list read after change covers; returns held input it shows to be a person's. */
    list: (covers: number, devices: ReadonlyMap<number, boolean>) => {
      list = { covers, devices };
      const people: HumanInput[] = [];
      const waiting: typeof held = [];
      for (const entry of held) {
        if (entry.change > covers) waiting.push(entry);
        else if (touchedBetween(entry.change, covers, entry.device)) people.push(entry.input);
        else if (devices.get(entry.device) !== false) people.push(entry.input);
      }
      held = waiting;
      const oldest = Math.min(covers, ...held.map((entry) => entry.change));
      for (const change of touched.keys()) if (change <= oldest) touched.delete(change);
      return people;
    },
    /** Whether a newer list is needed: a change it has not read, or input it has not covered. */
    stale: () => list?.covers !== changes || held.length > 0,
  };
}

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

/** Whether a negotiated XI version puts a source device on raw events (2.1 and later). */
export const supportsSourceId = (major: number, minor: number) =>
  major > 2 || (major === 2 && minor >= 1);

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
  /** For tests: a scripted server's socket, and when a device list or the connection ends. */
  observe: {
    readonly socketPath?: string;
    readonly onListed?: () => void;
    readonly onLost?: () => void;
  } = {},
): Promise<HumanInputSource | undefined> {
  const display = localDisplayNumber(environment.DISPLAY);
  if (display === null) return undefined;
  const authFile = environment.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
  const cookie = await NodeFSP.readFile(authFile).then(
    (bytes) => xauthorityCookie(bytes, display),
    () => null,
  );
  const socket = NodeNet.createConnection(observe.socketPath ?? "/tmp/.X11-unix/X" + display);
  let buffer = new Uint8Array(0);
  let closed = false;
  let latest: HumanInput | undefined;
  let major: number | undefined;
  const ledger = makeDeviceLedger();
  let refreshing = false;
  const waiting: Array<(message: Uint8Array | undefined) => void> = [];
  let setup: ((reply: Uint8Array | undefined) => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    observe.onLost?.();
    setup?.(undefined);
    for (const wake of waiting.splice(0)) wake(undefined);
  };
  const count = (input: HumanInput) => {
    if (latest === undefined || input.at > latest.at) latest = input;
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
      // Events selected before the first list are recorded too; that list then reads them.
      if (major === undefined) continue;
      const change = hierarchyChange(message, major);
      if (change !== undefined) {
        ledger.change(change);
        void refresh();
        continue;
      }
      const raw = parseRawEvent(message, major);
      if (!raw) continue;
      const input = { at: now(), source: raw.source };
      const outcome = ledger.input(raw.device, input);
      if (outcome === "person") count(input);
      else if (outcome === "held") void refresh();
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
  /** Reads device lists, one at a time, until one covers every change and held input. */
  const refresh = async (): Promise<void> => {
    if (major === undefined || closed || refreshing) return;
    refreshing = true;
    try {
      while (!closed && ledger.stale()) {
        // Requests are answered in order, so the list reflects every change announced so far.
        const covers = ledger.changes();
        const list = await ask(xiQueryDevice(major));
        if (!list || list[0] !== 1) return close();
        for (const input of ledger.list(covers, classifyDevices(parseDevices(list)))) count(input);
        observe.onListed?.();
      }
    } finally {
      refreshing = false;
    }
  };
  const fail = () => {
    close();
    return undefined;
  };
  if (root === undefined) return fail();
  const extension = await ask(queryExtension("XInputExtension"));
  if (!extension || extension[0] !== 1 || extension[8] !== 1) return fail();
  const opcode = extension[9] ?? 0;
  const version = await ask(xiQueryVersion(opcode));
  if (!version || version[0] !== 1) return fail();
  const versionView = new DataView(version.buffer, version.byteOffset, version.byteLength);
  // Raw events name their source device only from XI 2.1.
  if (!supportsSourceId(versionView.getUint16(8, true), versionView.getUint16(10, true)))
    return fail();
  // Select first, then list: every change from here on is an event the ledger records, and the
  // first list (whose reply also proves the select raised no error) catches up with them.
  socket.write(xiSelectRawEvents(opcode, root));
  major = opcode;
  await refresh();
  if (closed) return fail();
  return { latest: () => latest, lost: () => closed, close };
}
