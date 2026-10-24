import { describe, expect, it } from "vite-plus/test";

import { parseDevices, parseRawEvent, personDevices } from "./humanInputSource.ts";

/** An XIQueryDevice reply carrying these devices, each with one 8-byte class. */
function devicesReply(devices: ReadonlyArray<{ id: number; use: number; name: string }>) {
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
  view.setUint32(4, parts.length / 4, true);
  view.setUint16(8, devices.length, true);
  reply.set(parts, 32);
  return reply;
}

/** A raw XI2 event of evtype from sourceid, for extension opcode major. */
function rawEvent(major: number, evtype: number, sourceid: number) {
  const event = new Uint8Array(32);
  const view = new DataView(event.buffer);
  event[0] = 35;
  event[1] = major;
  view.setUint16(8, evtype, true);
  view.setUint16(10, sourceid, true);
  view.setUint16(20, sourceid, true);
  return event;
}

describe("XInput2 human input", () => {
  // As Xvfb lists them, plus a uinput keyboard the driver would add.
  const devices = parseDevices(
    devicesReply([
      { id: 2, use: 1, name: "Virtual core pointer" },
      { id: 3, use: 2, name: "Virtual core keyboard" },
      { id: 4, use: 3, name: "Virtual core XTEST pointer" },
      { id: 5, use: 4, name: "Virtual core XTEST keyboard" },
      { id: 6, use: 3, name: "Xvfb mouse" },
      { id: 7, use: 4, name: "Xvfb keyboard" },
    ]),
  );

  it("reads every device from a query reply, classes skipped", () => {
    expect(devices.map((device) => [device.id, device.name])).toEqual([
      [2, "Virtual core pointer"],
      [3, "Virtual core keyboard"],
      [4, "Virtual core XTEST pointer"],
      [5, "Virtual core XTEST keyboard"],
      [6, "Xvfb mouse"],
      [7, "Xvfb keyboard"],
    ]);
  });

  it("counts physical slaves as the person's, never masters or XTEST devices", () => {
    expect([...personDevices(devices)].toSorted()).toEqual([6, 7]);
  });

  it("reads key, button and motion raw events and the device they came from", () => {
    expect(parseRawEvent(rawEvent(131, 13, 7), 131)).toEqual({ source: "keyboard", device: 7 });
    expect(parseRawEvent(rawEvent(131, 15, 6), 131)).toEqual({ source: "pointer", device: 6 });
    expect(parseRawEvent(rawEvent(131, 17, 6), 131)).toEqual({ source: "pointer", device: 6 });
    // Another extension's generic event, or a raw release, is not input to report.
    expect(parseRawEvent(rawEvent(140, 13, 7), 131)).toBeUndefined();
    expect(parseRawEvent(rawEvent(131, 14, 7), 131)).toBeUndefined();
  });
});
