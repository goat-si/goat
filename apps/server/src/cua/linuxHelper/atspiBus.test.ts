// @effect-diagnostics nodeBuiltinImport:off -- A fake accessibility bus on a unix socket.
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { BusError, decodeMessage, encodeCall, makeAtspiBus } from "./atspiBus.ts";

/** Messages as dbus-next 0.10.2 marshals them. */
const DBUS_NEXT = {
  getMatches:
    "6c0100013c000000070000007b00000001016f00020000002f7700000000000002017300190000006f72672e613131792e61747370692e436f6c6c656374696f6e00000000000000030173000a0000004765744d61746368657300000000000006017300040000003a312e3900000000080167001528616969617b73737d696169696173696229756962000000000000080000000010000000000000010000000000000000000000010000000000000001000000000000000100000000000000010000000400000001000000",
  hello:
    "6c01000100000000010000006d00000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e4442757300000000030173000500000048656c6c6f00000006017300140000006f72672e667265656465736b746f702e4442757300000000",
  pid: "6c01000109000000020000008f00000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e4442757300000000030173001a000000476574436f6e6e656374696f6e556e697850726f63657373494400000000000006017300140000006f72672e667265656465736b746f702e44427573000000000801670001730000040000003a312e3900",
  references:
    "6c020001350000000300000033000000050175000700000006017300050000003a312e353000000007017300040000003a312e390000000008016700056128736f290000000000002d00000000000000040000003a312e3900000000020000002f61000000000000040000003a312e3900000000040000002f622f6300",
  states:
    "6c0200010c0000000400000030000000050175000800000006017300050000003a312e353000000007017300040000003a312e39000000000801670002617500080000000010004300000000",
  interfaces:
    "6c020001410000000500000030000000050175000900000006017300050000003a312e353000000007017300040000003a312e390000000008016700026173003d000000190000006f72672e613131792e61747370692e41636365737369626c65000000180000006f72672e613131792e61747370692e436f6d706f6e656e7400",
  unknownMethod:
    "6c03000116000000060000006700000004017300280000006f72672e667265656465736b746f702e444275732e4572726f722e556e6b6e6f776e4d6574686f640000000000000000050175000a00000006017300050000003a312e353000000007017300040000003a312e39000000000801670001730000110000004e6f207375636820696e7465726661636500",
};

const bytes = (hex: string) => Buffer.from(hex, "hex");

/** A reply fixture answering the call with this serial, written into its REPLY_SERIAL field. */
const answering = (hex: string, serial: number) => {
  const reply = bytes(hex);
  reply.writeUInt32LE(serial, reply.indexOf(bytes("05017500")) + 4);
  return reply;
};

const HELLO = {
  destination: "org.freedesktop.DBus",
  path: "/org/freedesktop/DBus",
  iface: "org.freedesktop.DBus",
  member: "Hello",
};

describe("accessibility bus calls", () => {
  it("writes calls and reads replies byte for byte as dbus-next does", () => {
    expect(
      encodeCall(7, {
        destination: ":1.9",
        path: "/w",
        iface: "org.a11y.atspi.Collection",
        member: "GetMatches",
        signature: "(aiia{ss}iaiiasib)uib",
        body: [[[4096, 0], 1, [], 1, [], 1, [], 1, false], 1, 4, true],
      }).toString("hex"),
    ).toBe(DBUS_NEXT.getMatches);
    expect(encodeCall(1, HELLO).toString("hex")).toBe(DBUS_NEXT.hello);
    expect(
      encodeCall(2, {
        ...HELLO,
        member: "GetConnectionUnixProcessID",
        signature: "s",
        body: [":1.9"],
      }).toString("hex"),
    ).toBe(DBUS_NEXT.pid);
    expect(decodeMessage(bytes(DBUS_NEXT.references))?.message).toMatchObject({
      type: 2,
      replySerial: 7,
      signature: "a(so)",
      body: [
        [
          [":1.9", "/a"],
          [":1.9", "/b/c"],
        ],
      ],
    });
    expect(decodeMessage(bytes(DBUS_NEXT.states))?.message).toMatchObject({
      signature: "au",
      body: [[1124077568, 0]],
    });
    expect(decodeMessage(bytes(DBUS_NEXT.interfaces))?.message).toMatchObject({
      signature: "as",
      body: [["org.a11y.atspi.Accessible", "org.a11y.atspi.Component"]],
    });
    expect(decodeMessage(bytes(DBUS_NEXT.unknownMethod))?.message).toMatchObject({
      type: 3,
      errorName: "org.freedesktop.DBus.Error.UnknownMethod",
      body: ["No such interface"],
    });
    // Half a message is not read yet; a body of a type this does not read is no body.
    expect(decodeMessage(bytes(DBUS_NEXT.states).subarray(0, 40))).toBeUndefined();
    const sixtyFour = bytes(DBUS_NEXT.states.replace("02617500", "02617400"));
    expect(decodeMessage(sixtyFour)?.message.body).toBeInstanceOf(Error);
  });

  it("answers calls over one connection, names error replies, and connects again after the bus drops it", async () => {
    const socketPath = NodePath.join(NodeOs.tmpdir(), "goat-atspi-bus-" + process.pid + ".sock");
    const clients: NodeNet.Socket[] = [];
    const server = NodeNet.createServer((client) => {
      clients.push(client);
      let buffered = Buffer.alloc(0);
      let begun = false;
      client.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!begun) {
          if (buffered.includes("AUTH EXTERNAL") && !buffered.includes("BEGIN")) {
            client.write("OK 0123456789abcdef\r\n");
            return;
          }
          const begin = buffered.indexOf("BEGIN\r\n");
          if (begin < 0) return;
          buffered = buffered.subarray(begin + 7);
          begun = true;
        }
        for (let next = decodeMessage(buffered); next; next = decodeMessage(buffered)) {
          buffered = buffered.subarray(next.length);
          const { serial, member } = next.message;
          client.write(
            answering(
              member === "GetState" ? DBUS_NEXT.unknownMethod : DBUS_NEXT.references,
              serial,
            ),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const call = makeAtspiBus({ address: async () => "unix:path=" + socketPath, uid: 1000 });
      const children = {
        destination: ":1.9",
        path: "/w",
        iface: "org.a11y.atspi.Accessible",
        member: "GetChildren",
      };
      expect(await call(children)).toEqual({
        signature: "a(so)",
        body: [
          [
            [":1.9", "/a"],
            [":1.9", "/b/c"],
          ],
        ],
      });
      const refused = await call({ ...children, member: "GetState" }).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(BusError);
      expect(refused).toMatchObject({ errorName: "org.freedesktop.DBus.Error.UnknownMethod" });
      expect(clients).toHaveLength(1);
      const dropped = clients[0];
      await new Promise<void>((resolve) => {
        dropped?.once("close", () => resolve());
        dropped?.destroy();
      });
      expect((await call(children)).signature).toBe("a(so)");
      expect(clients).toHaveLength(2);
    } finally {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
