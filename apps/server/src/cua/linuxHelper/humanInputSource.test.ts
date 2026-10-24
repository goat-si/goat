// @effect-diagnostics nodeBuiltinImport:off -- A scripted X server on a Unix socket stands in for Xorg.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  classifyDevices,
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
async function scriptedServer(options: { readonly minor: number }) {
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
        } else if (op === MAJOR && minor === 48) socket.write(devicesReply(deviceList));
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
    close: () => {
      client?.destroy();
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Lets the socket deliver what the server wrote, and any read it starts, to settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const settled = async () => {
  for (let round = 0; round < 10; round++) await settle();
};

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
    const source = await openX11HumanInput({ DISPLAY: ":0" }, () => 1, server.path);
    expect(source).toBeUndefined();
    server.close();
  });

  it("a keyboard plugged in after the source opened is the person's; the driver's devices never are", async () => {
    const server = await scriptedServer({ minor: 2 });
    let clock = 0;
    const source = await openX11HumanInput({ DISPLAY: ":0" }, () => ++clock, server.path);
    if (!source) throw new Error("no source");
    // The driver adds its devices and types through them: not a person.
    server.setDevices([...XVFB, ...DRIVER]);
    server.send(xiEvent(HIERARCHY));
    server.send(xiEvent(RAW_KEY, 11));
    await settled();
    expect(source.latest()).toBeUndefined();
    // A person plugs in a keyboard, which gets an id the driver's keyboard had before.
    server.setDevices([...XVFB, { id: 11, use: 4, name: "Logitech USB Keyboard" }]);
    server.send(xiEvent(HIERARCHY));
    server.send(xiEvent(RAW_KEY, 11));
    await settled();
    expect(source.latest()).toMatchObject({ source: "keyboard" });
    source.close();
    server.close();
  });

  it("input from a device the list does not have yet waits for the next list", async () => {
    const server = await scriptedServer({ minor: 2 });
    const source = await openX11HumanInput({ DISPLAY: ":0" }, () => 5, server.path);
    if (!source) throw new Error("no source");
    // The raw event arrives before the hierarchy event that announces its device.
    server.setDevices([...XVFB, { id: 20, use: 4, name: "Bluetooth Keyboard" }]);
    server.send(xiEvent(RAW_KEY, 20));
    await settled();
    expect(source.latest()).toEqual({ at: 5, source: "keyboard" });
    source.close();
    server.close();
  });

  it("a server that goes away leaves the source lost", async () => {
    const server = await scriptedServer({ minor: 2 });
    const source = await openX11HumanInput({ DISPLAY: ":0" }, () => 1, server.path);
    if (!source) throw new Error("no source");
    server.close();
    await settled();
    expect(source.lost()).toBe(true);
  });
});
