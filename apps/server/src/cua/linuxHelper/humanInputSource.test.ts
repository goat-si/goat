// @effect-diagnostics nodeBuiltinImport:off -- A scripted X server on a Unix socket stands in for Xorg.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  classifyDevices,
  hierarchyChange,
  makeDeviceLedger,
  openX11HumanInput,
  parseDevices,
  parseRawEvent,
  supportsSourceId,
  type XiDevice,
} from "./humanInputSource.ts";

const MAJOR = 131;

/** An XIQueryDevice reply carrying these devices, each with one 8-byte class. */
function devicesReply(devices: ReadonlyArray<XiDevice>, sequence = 0) {
  const parts: number[] = [];
  for (const device of devices) {
    const name = new TextEncoder().encode(device.name);
    const padded = name.length + ((4 - (name.length % 4)) % 4);
    const info = new Uint8Array(12 + padded + 8);
    const view = new DataView(info.buffer);
    view.setUint16(0, device.id, true);
    view.setUint16(2, device.use, true);
    view.setUint16(6, 1, true);
    view.setUint16(8, name.length, true);
    info.set(name, 12);
    view.setUint16(12 + padded + 2, 2, true);
    parts.push(...info);
  }
  const reply = new Uint8Array(32 + parts.length);
  const view = new DataView(reply.buffer);
  reply[0] = 1;
  view.setUint16(2, sequence, true);
  view.setUint32(4, parts.length / 4, true);
  view.setUint16(8, devices.length, true);
  reply.set(parts, 32);
  return reply;
}

/** A generic XI2 event of evtype; raw events carry sourceid. */
function xiEvent(evtype: number, sourceid = 0) {
  const event = new Uint8Array(32);
  const view = new DataView(event.buffer);
  event[0] = 35;
  event[1] = MAJOR;
  view.setUint16(8, evtype, true);
  view.setUint16(10, sourceid, true);
  view.setUint16(20, sourceid, true);
  return event;
}

const RAW_KEY = 13;
const HIERARCHY = 11;
const SLAVE_ADDED = 0x4;

/** A hierarchy event whose infos say these ids were added. */
function hierarchyEvent(added: ReadonlyArray<number>) {
  const event = new Uint8Array(32 + 12 * added.length);
  const view = new DataView(event.buffer);
  event[0] = 35;
  event[1] = MAJOR;
  view.setUint32(4, (12 * added.length) / 4, true);
  view.setUint16(8, HIERARCHY, true);
  view.setUint32(16, SLAVE_ADDED, true);
  view.setUint16(20, added.length, true);
  added.forEach((id, index) => {
    view.setUint16(32 + 12 * index, id, true);
    view.setUint32(32 + 12 * index + 8, SLAVE_ADDED, true);
  });
  return event;
}

// As Xvfb lists them, and Cua Driver's MPX devices as its source names them.
const XVFB: ReadonlyArray<XiDevice> = [
  { id: 2, use: 1, name: "Virtual core pointer" },
  { id: 3, use: 2, name: "Virtual core keyboard" },
  { id: 4, use: 3, name: "Virtual core XTEST pointer" },
  { id: 5, use: 4, name: "Virtual core XTEST keyboard" },
  { id: 6, use: 3, name: "Xvfb mouse" },
  { id: 7, use: 4, name: "Xvfb keyboard" },
];
const DRIVER: ReadonlyArray<XiDevice> = [
  { id: 8, use: 1, name: "CUA v1.AAAA.BBBB.CCCC pointer" },
  { id: 10, use: 3, name: "CUA v1.AAAA.BBBB.CCCC uinput pointer" },
  { id: 11, use: 4, name: "CUA v1.AAAA.BBBB.CCCC uinput keyboard" },
  { id: 12, use: 3, name: "CUA default mp-4242-1 XTEST pointer" },
];

/**
 * Answers the requests openX11HumanInput makes, in order: setup, QueryExtension, XIQueryVersion,
 * then XISelectEvents (no reply) and XIQueryDevice, each later XIQueryDevice with the current
 * device list.
 */
async function scriptedServer(options: {
  readonly minor: number;
  /** What to send after the nth XIQueryDevice reply, as one write with it. */
  readonly after?: (query: number) => ReadonlyArray<Uint8Array>;
}) {
  let queries = 0;
  /** A held XIQueryDevice is answered only when released, so events can go out first. */
  let hold = false;
  let held: (() => void) | undefined;
  let requested = Promise.withResolvers<void>();
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-x-"));
  const path = NodePath.join(dir, "X0");
  let client: NodeNet.Socket | undefined;
  let deviceList: ReadonlyArray<XiDevice> = XVFB;
  let gotSetup = false;
  const connected = Promise.withResolvers<void>();
  const server = NodeNet.createServer((socket) => {
    client = socket;
    connected.resolve();
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!gotSetup) {
        if (buffer.length < 12) return;
        gotSetup = true;
        buffer = buffer.subarray(12);
        // A setup reply with no vendor string and one screen whose root is 0x100.
        const reply = Buffer.alloc(40 + 4);
        reply[0] = 1;
        reply.writeUInt16LE((reply.length - 8) / 4, 6);
        reply.writeUInt32LE(0x100, 40);
        socket.write(reply);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const op = buffer[0];
        const minor = buffer[1];
        buffer = buffer.subarray(length);
        const reply = Buffer.alloc(32);
        reply[0] = 1;
        if (op === 98) {
          reply[8] = 1;
          reply[9] = MAJOR;
          socket.write(reply);
        } else if (op === MAJOR && minor === 47) {
          reply.writeUInt16LE(2, 8);
          reply.writeUInt16LE(options.minor, 10);
          socket.write(reply);
        } else if (op === MAJOR && minor === 48) {
          queries++;
          const answer = () =>
            socket.write(
              Buffer.concat([devicesReply(deviceList), ...(options.after?.(queries) ?? [])]),
            );
          requested.resolve();
          requested = Promise.withResolvers<void>();
          if (hold) {
            hold = false;
            held = answer;
          } else answer();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    connected: connected.promise,
    send: (bytes: Uint8Array) => client?.write(bytes),
    setDevices: (next: ReadonlyArray<XiDevice>) => {
      deviceList = next;
    },
    holdNextList: () => {
      hold = true;
    },
    listRequested: () => requested.promise,
    releaseList: () => held?.(),
    close: () => {
      client?.destroy();
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Resolves on the next device list the source applies, held input included. */
function lists() {
  let next = Promise.withResolvers<void>();
  return {
    onListed: () => {
      next.resolve();
      next = Promise.withResolvers<void>();
    },
    next: () => next.promise,
  };
}

describe("XInput2 human input", () => {
  it("reads every device from a query reply, classes skipped", () => {
    expect(parseDevices(devicesReply(XVFB))).toEqual(XVFB);
  });

  it("counts only slaves that are neither XTEST nor Cua Driver's as the person's", () => {
    const classes = classifyDevices([...XVFB, ...DRIVER]);
    expect([...classes].filter(([, person]) => person).map(([id]) => id)).toEqual([6, 7]);
  });

  it("reads key, button and motion raw events and the device they came from", () => {
    expect(parseRawEvent(xiEvent(13, 7), MAJOR)).toEqual({ source: "keyboard", device: 7 });
    expect(parseRawEvent(xiEvent(15, 6), MAJOR)).toEqual({ source: "pointer", device: 6 });
    expect(parseRawEvent(xiEvent(17, 6), MAJOR)).toEqual({ source: "pointer", device: 6 });
    expect(parseRawEvent(xiEvent(14, 7), MAJOR)).toBeUndefined();
  });

  it("raw events name their source device only from XI 2.1", () => {
    expect(supportsSourceId(2, 0)).toBe(false);
    expect(supportsSourceId(2, 1)).toBe(true);
    expect(supportsSourceId(2, 4)).toBe(true);
  });

  it("refuses a server that negotiates XI 2.0, whose raw events name no device", async () => {
    const server = await scriptedServer({ minor: 0 });
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
      },
    );
    expect(source).toBeUndefined();
    server.close();
  });

  it("a keyboard plugged in after the source opened is the person's; the driver's devices never are", async () => {
    const server = await scriptedServer({ minor: 2 });
    const listed = lists();
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
        onListed: listed.onListed,
      },
    );
    if (!source) throw new Error("no source");
    // The driver adds its devices and types through them: not a person.
    server.setDevices([...XVFB, ...DRIVER]);
    let applied = listed.next();
    server.send(hierarchyEvent([8, 10, 11, 12]));
    server.send(xiEvent(RAW_KEY, 11));
    await applied;
    expect(source.latest()).toBeUndefined();
    // A person plugs in a keyboard, which gets an id the driver's keyboard had before.
    server.setDevices([...XVFB, { id: 11, use: 4, name: "Logitech USB Keyboard" }]);
    applied = listed.next();
    server.send(hierarchyEvent([11]));
    server.send(xiEvent(RAW_KEY, 11));
    await applied;
    expect(source.latest()).toMatchObject({ source: "keyboard" });
    source.close();
    server.close();
  });

  it("input from a device the list does not have yet waits for the next list", async () => {
    const server = await scriptedServer({ minor: 2 });
    const listed = lists();
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
        onListed: listed.onListed,
      },
    );
    if (!source) throw new Error("no source");
    // The raw event arrives before the hierarchy event that announces its device.
    server.setDevices([...XVFB, { id: 20, use: 4, name: "Bluetooth Keyboard" }]);
    const applied = listed.next();
    server.send(xiEvent(RAW_KEY, 20));
    await applied;
    expect(source.latest()).toMatchObject({ source: "keyboard" });
    source.close();
    server.close();
  });

  it("a device change that arrives with the first list is caught up, not lost", async () => {
    // The first reply carries the driver's keyboard on id 11; a change and a person's key on a
    // reused 11 follow in the same write, before the source has finished opening.
    let devicesNow: ReadonlyArray<XiDevice> = [...XVFB, ...DRIVER];
    const server = await scriptedServer({
      minor: 2,
      after: (query) => {
        if (query !== 1) return [];
        devicesNow = [...XVFB, { id: 11, use: 4, name: "Logitech USB Keyboard" }];
        return [hierarchyEvent([11]), xiEvent(RAW_KEY, 11)];
      },
    });
    server.setDevices(devicesNow);
    const listed = lists();
    const second = listed.next().then(() => listed.next());
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
        onListed: () => {
          server.setDevices(devicesNow);
          listed.onListed();
        },
      },
    );
    if (!source) throw new Error("no source");
    await second;
    expect(source.latest()).toMatchObject({ source: "keyboard" });
    source.close();
    server.close();
  });

  it("input held across a change keeps waiting for a list read after that change", async () => {
    // Another change and the person's key arrive in the same write as the list the source was
    // waiting for; that list predates the change and must not decide the key.
    let devicesNow: ReadonlyArray<XiDevice> = [...XVFB, ...DRIVER];
    const server = await scriptedServer({
      minor: 2,
      after: (query) => {
        if (query !== 2) return [];
        devicesNow = [...XVFB, { id: 11, use: 4, name: "Logitech USB Keyboard" }];
        return [hierarchyEvent([11]), xiEvent(RAW_KEY, 11)];
      },
    });
    server.setDevices(devicesNow);
    const listed = lists();
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
        onListed: () => {
          server.setDevices(devicesNow);
          listed.onListed();
        },
      },
    );
    if (!source) throw new Error("no source");
    const third = listed.next().then(() => listed.next());
    server.send(hierarchyEvent([8, 10, 11, 12]));
    await third;
    expect(source.latest()).toMatchObject({ source: "keyboard" });
    source.close();
    server.close();
  });

  it("a device id reused while a list is being read never drops a person's held key", async () => {
    // The keyboard on 11 is a person's. An unrelated change starts a read; the person's key is
    // held for it; then 11 is removed and the driver's keyboard takes it, and those changes are
    // announced before the reply, which already lists the driver's device.
    const removed = hierarchyEvent([11]);
    new DataView(removed.buffer).setUint32(16, 0x8, true);
    new DataView(removed.buffer).setUint32(40, 0x8, true);
    const server = await scriptedServer({
      minor: 2,
      after: () => [],
    });
    server.setDevices([...XVFB, { id: 11, use: 4, name: "Logitech USB Keyboard" }]);
    const listed = lists();
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
        onListed: listed.onListed,
      },
    );
    if (!source) throw new Error("no source");
    server.holdNextList();
    const applied = listed.next();
    server.send(hierarchyEvent([30]));
    server.send(xiEvent(RAW_KEY, 11));
    await server.listRequested();
    server.setDevices([...XVFB, { id: 11, use: 4, name: "CUA v1.AAAA.BBBB.CCCC uinput keyboard" }]);
    server.send(removed);
    server.send(hierarchyEvent([11]));
    server.releaseList();
    await applied;
    expect(source.latest()).toMatchObject({ source: "keyboard" });
    source.close();
    server.close();
  });

  it("a server that goes away leaves the source lost", async () => {
    const server = await scriptedServer({ minor: 2 });
    const lost = Promise.withResolvers<void>();
    const source = await openX11HumanInput(
      { DISPLAY: ":0" },
      {
        socketPath: server.path,
        onLost: () => lost.resolve(),
      },
    );
    if (!source) throw new Error("no source");
    server.close();
    await lost.promise;
    expect(source.lost()).toBe(true);
  });
});

describe("makeDeviceLedger", () => {
  const key = (order: number) => ({ order, source: "keyboard" as const });
  const driver = new Map([[11, false]]);
  const person = new Map([[11, true]]);

  it("input under a current list is decided at once", () => {
    const ledger = makeDeviceLedger();
    ledger.list(0, person);
    expect(ledger.input(11, key(1))).toBe("person");
    ledger.list(0, driver);
    expect(ledger.input(11, key(2))).toBe("drop");
  });

  it("input after an unread change waits, and a list read after it decides", () => {
    const ledger = makeDeviceLedger();
    ledger.list(0, driver);
    ledger.change(new Set([11]));
    expect(ledger.input(11, key(3))).toBe("held");
    expect(ledger.stale()).toBe(true);
    expect(ledger.list(1, person)).toEqual([key(3)]);
    expect(ledger.stale()).toBe(false);
  });

  it("a list read before the input's change never decides it", () => {
    const ledger = makeDeviceLedger();
    ledger.list(0, driver);
    ledger.change(new Set([11]));
    expect(ledger.input(11, key(4))).toBe("held");
    // The list that was in flight covers change 0 only.
    expect(ledger.list(0, driver)).toEqual([]);
    expect(ledger.stale()).toBe(true);
    expect(ledger.list(1, person)).toEqual([key(4)]);
  });

  it("when a later change touched the input's id, the input counts as a person's", () => {
    const ledger = makeDeviceLedger();
    ledger.list(0, person);
    ledger.change(new Set([11]));
    expect(ledger.input(11, key(5))).toBe("held");
    // Then the keyboard goes and the driver's device takes id 11.
    ledger.change(new Set([11]));
    expect(ledger.list(2, driver)).toEqual([key(5)]);
  });

  it("a later change to other ids leaves the list's word on this one", () => {
    const ledger = makeDeviceLedger();
    ledger.list(0, driver);
    ledger.change(new Set([30]));
    expect(ledger.input(11, key(6))).toBe("held");
    ledger.change(new Set([31]));
    expect(ledger.list(2, driver)).toEqual([]);
  });

  it("input from an id no list has counts as a person's", () => {
    const ledger = makeDeviceLedger();
    ledger.list(0, new Map());
    expect(ledger.input(40, key(7))).toBe("held");
    expect(ledger.list(0, new Map())).toEqual([key(7)]);
  });
});

describe("hierarchyChange", () => {
  it("names the ids a hierarchy event added or removed", () => {
    expect(hierarchyChange(hierarchyEvent([11, 12]), MAJOR)).toEqual(new Set([11, 12]));
    expect(hierarchyChange(xiEvent(RAW_KEY, 11), MAJOR)).toBeUndefined();
  });
});
