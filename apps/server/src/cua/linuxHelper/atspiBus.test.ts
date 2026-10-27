// @effect-diagnostics nodeBuiltinImport:off -- A fake accessibility bus on a unix socket.
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { BusError, DAEMON, makeAtspiBus } from "./atspiBus.ts";
import { makeSecureFocusProbe } from "./atspiFocus.ts";

/** Every connection the client opens, so a test can see what dbus-next still holds for it. */
const buses = vi.hoisted((): Array<unknown> => []);
vi.mock("dbus-next", async (original) => {
  const real = await original<typeof import("dbus-next")>();
  return {
    ...real,
    sessionBus: (...args: Parameters<typeof real.sessionBus>) => {
      const bus = real.sessionBus(...args);
      buses.push(bus);
      return bus;
    },
  };
});

/** dbus-next's own wire format, so the fake bus speaks exactly what the client reads. */
const requireModule = NodeModule.createRequire(import.meta.url);
const { marshallMessage } = requireModule("dbus-next/lib/marshall-compat") as {
  marshallMessage: (message: object) => [Buffer];
};
const { unmarshalMessages } = requireModule("dbus-next/lib/message") as {
  unmarshalMessages: (
    stream: NodeNet.Socket,
    onMessage: (message: Incoming) => void,
    options: object,
  ) => void;
};

interface Incoming {
  readonly serial: number;
  readonly destination?: string;
  readonly member?: string;
  readonly body?: ReadonlyArray<unknown>;
}

const ACCESSIBLE = "org.a11y.atspi.Accessible";
let serials = 1000;
const reply = (to: Incoming, sender: string, signature: string, body: ReadonlyArray<unknown>) =>
  marshallMessage({
    type: 2,
    serial: serials++,
    replySerial: to.serial,
    sender,
    destination: ":1.50",
    signature,
    body,
  })[0];
const refusal = (to: Incoming, sender: string, errorName: string) =>
  marshallMessage({
    type: 3,
    serial: serials++,
    replySerial: to.serial,
    sender,
    destination: ":1.50",
    errorName,
    signature: "s",
    body: ["refused"],
  })[0];

/** The reply a reviewer sent: an a(so) whose type code 'a' became the byte 0xe1. */
const unreadable = (to: Incoming, list: ReadonlyArray<unknown> = [[":1.9", "/a"]]) => {
  const bytes = reply(to, to.destination ?? "", "a(so)", [list]);
  bytes[bytes.indexOf(Buffer.from("a(so)"))] = 0xe1;
  return bytes;
};

let sockets = 0;

/** A bus that lets this process in, answers Hello as the bus daemon, and hands every other call on. */
async function fakeBus(onCall: (call: Incoming, client: NodeNet.Socket) => void) {
  const socketPath = NodePath.join(
    NodeOS.tmpdir(),
    "goat-atspi-bus-" + process.pid + "-" + sockets++ + ".sock",
  );
  const clients: NodeNet.Socket[] = [];
  const calls: Incoming[] = [];
  const server = NodeNet.createServer((client) => {
    clients.push(client);
    let buffered = "";
    const onAuth = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      if (
        buffered.includes("AUTH") &&
        !buffered.includes("BEGIN\r\n") &&
        !buffered.includes("\u0001")
      ) {
        if (!client.writableEnded) client.write("OK 0123456789abcdef0123456789abcdef\r\n");
        buffered = buffered.replace(/AUTH[^\r]*\r\n/g, "\u0001");
      }
      const begin = buffered.indexOf("BEGIN\r\n");
      if (begin < 0) return;
      client.off("data", onAuth);
      const rest = Buffer.from(buffered.slice(begin + 7), "latin1");
      if (rest.length > 0) client.unshift(rest);
      unmarshalMessages(
        client,
        (message) => {
          if (message.member === "Hello")
            return client.write(reply(message, DAEMON, "s", [":1.50"]));
          calls.push(message);
          onCall(message, client);
        },
        {},
      );
    };
    client.on("data", onAuth);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    address: "unix:path=" + socketPath,
    clients,
    calls,
    [Symbol.asyncDispose]: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const live = () => new AbortController().signal;
const children = (destination: string) => ({
  destination,
  path: "/w",
  iface: ACCESSIBLE,
  member: "GetChildren",
});

describe("accessibility bus calls", () => {
  it("takes a reply only from the peer it called, and a refusal from the bus daemon only as a failure", async () => {
    await using bus = await fakeBus((call, client) => {
      if (call.destination === ":1.9") client.write(reply(call, ":9.9", "a(so)", [[]]));
      if (call.destination === ":1.10")
        client.write(reply(call, ":1.10", "a(so)", [[[":1.10", "/a"]]]));
      if (call.destination === ":1.11")
        client.write(refusal(call, DAEMON, "org.freedesktop.DBus.Error.ServiceUnknown"));
    });
    const call = makeAtspiBus({ address: async () => bus.address });
    const [forged, real, refused] = await Promise.allSettled([
      call(children(":1.9"), live()),
      call(children(":1.10"), live()),
      call(children(":1.11"), live()),
    ]);
    expect(forged.status).toBe("rejected");
    expect(real).toMatchObject({
      status: "fulfilled",
      value: { signature: "a(so)", body: [[[":1.10", "/a"]]], connection: 1 },
    });
    expect(refused).toMatchObject({
      status: "rejected",
      reason: { errorName: "org.freedesktop.DBus.Error.ServiceUnknown" },
    });
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(BusError);
  });

  it("calls only unique names and the bus daemon, so who answers can be checked", async () => {
    await using bus = await fakeBus(() => undefined);
    const call = makeAtspiBus({ address: async () => bus.address });
    await expect(call(children("org.a11y.atspi.Registry"), live())).rejects.toThrow();
    expect(bus.calls).toEqual([]);
  });

  it("ends a connection that sends a reply it cannot read, failing the waiting call, and opens a new one for the next", async () => {
    let first = true;
    await using bus = await fakeBus((call, client) => {
      client.write(first ? unreadable(call) : reply(call, call.destination ?? "", "a(so)", [[]]));
      first = false;
    });
    const call = makeAtspiBus({ address: async () => bus.address });
    await expect(call(children(":1.9"), live())).rejects.toThrow();
    expect(await call(children(":1.9"), live())).toMatchObject({
      signature: "a(so)",
      connection: 2,
    });
    expect(bus.clients).toHaveLength(2);
  });

  it("sends nothing for a call cancelled before it goes out, and stops waiting for one cancelled after", async () => {
    const sent = Promise.withResolvers<void>();
    await using bus = await fakeBus(() => sent.resolve());
    const call = makeAtspiBus({ address: async () => bus.address });
    const before = new AbortController();
    before.abort();
    await expect(call(children(":1.9"), before.signal)).rejects.toThrow();
    const after = new AbortController();
    const waiting = call(children(":1.9"), after.signal);
    await sent.promise;
    after.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    expect(bus.calls).toHaveLength(1);
  });

  it("answers a probe unknown when the reply that says nothing is focused cannot be read", async () => {
    const ROOT = "/org/a11y/atspi/accessible/root";
    await using bus = await fakeBus((call, client) => {
      if (call.member === "GetNameOwner") return client.write(reply(call, DAEMON, "s", [":1.7"]));
      if (call.member === "GetConnectionUnixProcessID")
        return client.write(reply(call, DAEMON, "u", [10]));
      if (call.member === "GetChildren")
        return client.write(
          call.destination === ":1.7"
            ? reply(call, ":1.7", "a(so)", [[[":1.9", ROOT]]])
            : reply(call, ":1.9", "a(so)", [[[":1.9", "/w"]]]),
        );
      // Read as text with the high bit dropped, 0xe1 is 'a' again, and this says nothing is focused.
      if (call.member === "GetMatches") return client.write(unreadable(call, []));
    });
    const probe = makeSecureFocusProbe(async () => "('" + bus.address + "',)\n");
    expect(await probe(10)).toEqual({ known: false, secure: false, windows: 0 });
  });

  it("forgets a cancelled call, so a peer that never answers leaves nothing waiting on the connection", async () => {
    const sent = Promise.withResolvers<void>();
    await using bus = await fakeBus(() => sent.resolve());
    const call = makeAtspiBus({ address: async () => bus.address });
    const cancel = new AbortController();
    const waiting = call(children(":1.9"), cancel.signal);
    await sent.promise;
    cancel.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    const opened = buses.at(-1);
    // dbus-next keeps a handler per call it is waiting on, until a reply with that serial comes.
    expect(
      Object.keys((opened as unknown as { _methodReturnHandlers: object })._methodReturnHandlers),
    ).toEqual([]);
  });
});
