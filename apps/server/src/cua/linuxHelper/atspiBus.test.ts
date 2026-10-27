// @effect-diagnostics nodeBuiltinImport:off -- A fake accessibility bus on a unix socket.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  BusError,
  type DbusValue,
  decodeMessage,
  encodeCall,
  encodeMessage,
  makeAtspiBus,
  type Message,
} from "./atspiBus.ts";

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
    await using bus = await fakeBus((call, client) =>
      client.write(
        call.member === "GetState"
          ? encodeMessage(next(), {
              type: ERROR,
              replySerial: call.serial,
              sender: call.destination ?? "",
              errorName: "org.freedesktop.DBus.Error.UnknownMethod",
              signature: "s",
              body: ["No such interface"],
            })
          : answer(call, call.destination ?? "", "a(so)", [[[":1.9", "/a"]]]),
      ),
    );
    const call = makeAtspiBus({ address: async () => bus.address, uid: 1000 });
    const children = { destination: ":1.9", path: "/w", iface: ACCESSIBLE, member: "GetChildren" };
    expect(await call(children)).toMatchObject({ signature: "a(so)", body: [[[":1.9", "/a"]]] });
    const refused = await call({ ...children, member: "GetState" }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(BusError);
    expect(refused).toMatchObject({ errorName: "org.freedesktop.DBus.Error.UnknownMethod" });
    expect(bus.clients).toHaveLength(1);
    const dropped = bus.clients[0];
    await new Promise<void>((resolve) => {
      dropped?.once("close", () => resolve());
      dropped?.destroy();
    });
    expect((await call(children)).signature).toBe("a(so)");
    expect(bus.clients).toHaveLength(2);
  });

  it("takes each reply only from the peer it called, matched by serial and sender, whatever order replies come in", async () => {
    const calls: Message[] = [];
    await using bus = await fakeBus((call, client) => {
      calls.push(call);
      const [a, b, c] = calls;
      if (a === undefined || b === undefined || c === undefined) return;
      client.write(
        Buffer.concat([
          // Another app answers A's call first, saying nothing is focused.
          answer(a, ":9.9", "au", [[PLAIN, 0]]),
          // An answer to no call.
          encodeMessage(next(), {
            type: RETURN,
            replySerial: 4242,
            sender: ":1.9",
            signature: "au",
            body: [[PLAIN, 0]],
          }),
          answer(b, ":1.10", "u", [40]),
          // The bus daemon refuses C: its own errors count.
          encodeMessage(next(), {
            type: ERROR,
            replySerial: c.serial,
            sender: DAEMON,
            errorName: "org.freedesktop.DBus.Error.ServiceUnknown",
            signature: "s",
            body: ["gone"],
          }),
          answer(a, ":1.9", "au", [[FOCUSED, 0]]),
        ]),
      );
    });
    const call = makeAtspiBus({ address: async () => bus.address, uid: 1000 });
    const [a, b, c] = await Promise.allSettled([
      call({ destination: ":1.9", path: "/a", iface: ACCESSIBLE, member: "GetState" }),
      call({ destination: ":1.10", path: "/b", iface: ACCESSIBLE, member: "GetRole" }),
      call({ destination: ":1.11", path: "/c", iface: ACCESSIBLE, member: "GetRole" }),
    ]);
    expect(a).toMatchObject({
      status: "fulfilled",
      value: { signature: "au", body: [[FOCUSED, 0]] },
    });
    expect(b).toMatchObject({ status: "fulfilled", value: { signature: "u", body: [40] } });
    expect(c).toMatchObject({
      status: "rejected",
      reason: { errorName: "org.freedesktop.DBus.Error.ServiceUnknown" },
    });
  });

  it("sends a call for a well-known name to the app that owns it, and takes the reply only from that app", async () => {
    const seen: Array<string | undefined> = [];
    await using bus = await fakeBus((call, client) => {
      seen.push(call.destination);
      if (call.member === "GetNameOwner") client.write(answer(call, DAEMON, "s", [":1.0"]));
      else {
        client.write(answer(call, "org.a11y.atspi.Registry", "a(so)", [[[":1.3", "/x"]]]));
        client.write(answer(call, ":1.0", "a(so)", [[[":1.7", "/root"]]]));
      }
    });
    const call = makeAtspiBus({ address: async () => bus.address, uid: 1000 });
    expect(
      await call({
        destination: "org.a11y.atspi.Registry",
        path: "/root",
        iface: ACCESSIBLE,
        member: "GetChildren",
      }),
    ).toMatchObject({ body: [[[":1.7", "/root"]]] });
    expect(seen).toEqual([DAEMON, ":1.0"]);
  });

  it("reads a body whose signature it cannot walk as no body, an empty struct among them, never looping on it", () => {
    for (const signature of [
      "a()",
      "a{}",
      "()",
      "{su}",
      "a{(s)u}",
      "a{suu}",
      "(".repeat(33) + "y" + ")".repeat(33),
      "a".repeat(33) + "y",
    ])
      expect(decodeMessage(rawReply(signature, Buffer.alloc(40)))?.message.body).toBeInstanceOf(
        Error,
      );
  });
});

/** A reply, headed by hand, so its signature is whatever the test says. Arrays in the body say 32 bytes. */
function rawReply(signature: string, body: Buffer): Buffer {
  const field = Buffer.concat([
    Buffer.from([8, 1, 0x67, 0, signature.length]),
    Buffer.from(signature, "ascii"),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(16);
  head.write("6c020001", "hex");
  head.writeUInt32LE(body.length, 4);
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(field.length, 12);
  const unpadded = Buffer.concat([head, field]);
  const padded = Buffer.concat([unpadded, Buffer.alloc((8 - (unpadded.length % 8)) % 8)]);
  const filled = Buffer.from(body);
  filled.writeUInt32LE(32, 0);
  return Buffer.concat([padded, filled]);
}

const RETURN = 2;
const ERROR = 3;
const DAEMON = "org.freedesktop.DBus";
const ACCESSIBLE = "org.a11y.atspi.Accessible";
const PLAIN = 1124073472;
const FOCUSED = 1124077568;
let serials = 1000;
const next = () => serials++;

/** A reply to a call, as the peer from says. */
const answer = (call: Message, from: string, signature: string, body: ReadonlyArray<DbusValue>) =>
  encodeMessage(next(), {
    type: RETURN,
    replySerial: call.serial,
    sender: from,
    destination: ":1.50",
    signature,
    body,
  });

let sockets = 0;

/** A bus that lets this process in, answers Hello as the bus daemon, and hands every other call on. */
async function fakeBus(onCall: (call: Message, client: NodeNet.Socket) => void) {
  const socketPath = NodePath.join(
    NodeOS.tmpdir(),
    "goat-atspi-bus-" + process.pid + "-" + sockets++ + ".sock",
  );
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
      for (let found = decodeMessage(buffered); found; found = decodeMessage(buffered)) {
        buffered = buffered.subarray(found.length);
        if (found.message.member === "Hello")
          client.write(answer(found.message, DAEMON, "s", [":1.50"]));
        else onCall(found.message, client);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    address: "unix:path=" + socketPath,
    clients,
    [Symbol.asyncDispose]: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
