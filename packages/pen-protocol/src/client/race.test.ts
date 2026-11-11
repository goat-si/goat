import { describe, expect, it, vi } from "vite-plus/test";
import vector from "../../vectors/session.json" with { type: "json" };
import { fromHex } from "./bytes.ts";
import { generateX25519, type KeyPair, x25519PublicKey } from "./crypto.ts";
import { Kind } from "./noise.ts";
import { openSession, type SessionOptions } from "./race.ts";
import { fakeFactory, type FakeSocket } from "./testing/fakeRelay.ts";
import { ManualClock } from "./testing/manualClock.ts";
import { respond } from "./testing/noiseResponder.ts";

const NODE = vector.responder.nodeId;
const A = "wss://relay-a.example";
const B = "wss://relay-b.example";
const serverKey: KeyPair = (() => {
  const privateKey = fromHex(vector.responder.noisePriv);
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
})();
let seed = 1;
const random = (n: number) => new Uint8Array(n).fill(seed++ & 255);
const phone = generateX25519(random);

function setup(overrides: Partial<SessionOptions> = {}) {
  const clock = new ManualClock();
  const fake = fakeFactory();
  const options: SessionOptions = {
    relays: [A, B],
    nodeId: NODE,
    serverNoisePub: serverKey.publicKey,
    kind: Kind.Session,
    payload: { v: 1, stream: "service", name: "goat" },
    localStatic: phone,
    factory: fake.factory,
    clock,
    random,
    ...overrides,
  };
  const result = openSession(options);
  // Settled is set when the race ends either way; tests await it instead of polling.
  let settled = false;
  void result.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { clock, fake, result, options, settled: () => settled };
}

/** Plays the Pen node on one relay socket: answers its message 1 with a real message 2. */
function answer(socket: FakeSocket) {
  const message1 = socket.binarySent()[0];
  if (message1 === undefined) throw new Error("no message 1 on " + socket.url);
  const reply = respond({
    kind: Kind.Session,
    nodeId: NODE,
    localStatic: serverKey,
    message1,
    psk: () => undefined,
    random,
  });
  socket.receive(reply.message2);
  return reply;
}

/** Opens the sockets and waits until each has sent its first message (message 1, or ping in a ping race). */
const flushOpen = async (...sockets: Array<FakeSocket>) => {
  for (const socket of sockets) socket.open();
  for (const socket of sockets) await socket.whenSent(1);
};

describe("handshake race (CONTRACT Several relays; Go daemon/race.go)", () => {
  it("the first verified message 2 wins and alone gets the key confirmation; the other socket closes 1000 unconfirmed", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    const replyB = answer(b);
    const opened = await t.result;
    expect(opened.relay).toBe(B);
    const confirmation = b.binarySent()[1];
    expect(confirmation).toBeDefined();
    expect(replyB.recv.open(confirmation ?? new Uint8Array())).toEqual(new Uint8Array(0));
    expect(a.closedWith).toBe(1000);
    expect(a.binarySent()).toHaveLength(1);
    expect(opened.handshakeHash).toEqual(replyB.handshakeHash);
  });

  it("every socket has its own ephemeral key", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    expect(a.binarySent()[0]?.subarray(1, 33)).not.toEqual(b.binarySent()[0]?.subarray(1, 33));
    answer(a);
    await t.result;
  });

  it("a 4401 on any socket ends the race as the node's refusal, even when a relay forged it", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    a.remoteClose(4401);
    await expect(t.result).rejects.toMatchObject({ closeCode: 4401 });
    expect(b.closedWith).toBe(1000);
  });

  it("a message 2 that fails to verify closes that socket 4400 and the race goes on", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    const forged = new Uint8Array(48);
    a.receive(forged);
    await a.whenClosed();
    expect(a.closedWith).toBe(4400);
    expect(t.settled()).toBe(false);
    answer(b);
    expect((await t.result).relay).toBe(B);
  });

  it("all relays offline is 4404", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    a.remoteClose(4404);
    b.remoteClose(4404);
    await expect(t.result).rejects.toMatchObject({ closeCode: 4404 });
  });

  it("dials have 15 s; a socket that connects at 14 s still gets its own 10 s handshake", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    t.clock.advance(14_000);
    await flushOpen(a);
    t.clock.advance(1_000);
    expect(b.closedWith).toBeNull();
    expect(t.settled()).toBe(false);
    t.clock.advance(8_999);
    answer(a);
    expect((await t.result).relay).toBe(A);
  });

  it.each(["winner", "refusal"] as const)(
    "after a %s, a dial that never opens is still abandoned at the 15 s dial deadline",
    async (outcome) => {
      const t = setup();
      const a = t.fake.socketFor(A);
      const b = t.fake.socketFor(B);
      await flushOpen(a);
      if (outcome === "winner") {
        answer(a);
        await t.result;
      } else {
        a.remoteClose(4401);
        await expect(t.result).rejects.toMatchObject({ closeCode: 4401 });
      }
      expect(b.closedWith).toBeUndefined();
      t.clock.advance(15_000);
      expect(b.closedWith).not.toBeUndefined();
    },
  );

  it("ping race: a relay whose ping cannot be sent counts as failed; the other relay wins, or the race ends at once", async () => {
    const pingOptions = {
      mode: "ping" as const,
      kind: Kind.Join,
      psk: fromHex(vector.ikpsk2.psk),
      payload: { v: 1, stream: "join", invite: "x", name: "p" },
    };
    const breakPing = (socket: FakeSocket) => {
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (data === "ping") throw new Error("socket gone");
        send(data);
      };
    };
    const only = setup({ ...pingOptions, relays: [A] });
    const lone = only.fake.socketFor(A);
    breakPing(lone);
    lone.open();
    await expect(only.result).rejects.toThrow("socket gone");
    expect(lone.closedWith).not.toBeUndefined();

    const two = setup(pingOptions);
    const a = two.fake.socketFor(A);
    const b = two.fake.socketFor(B);
    breakPing(a);
    a.open();
    b.open();
    await b.whenSent(1);
    b.receive("pong");
    await b.whenSent(2);
    expect(a.closedWith).not.toBeUndefined();
  });

  it("a handshake with no message 2 within 10 s closes 4408", async () => {
    const t = setup({ relays: [A] });
    await flushOpen(t.fake.socketFor(A));
    t.clock.advance(10_000);
    await expect(t.result).rejects.toMatchObject({ code: "handshake-timeout", closeCode: 4408 });
    expect(t.fake.socketFor(A).closedWith).toBe(4408);
  });

  it("a dial that finishes after the winner is closed 1000 at once and never sends message 1", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a);
    answer(a);
    await t.result;
    b.open();
    await b.whenClosed();
    expect(b.closedWith).toBe(1000);
    expect(b.binarySent()).toHaveLength(0);
  });

  it("a refusal and a verified answer in the same turn: the first one handled decides, the other closes 1000 unconfirmed", async () => {
    const t = setup();
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    b.remoteClose(4401);
    answer(a);
    await expect(t.result).rejects.toMatchObject({ closeCode: 4401 });
    expect(a.closedWith).toBe(1000);
    expect(a.binarySent()).toHaveLength(1);
  });

  it("a key confirmation that cannot be sent fails the race and closes the winner", async () => {
    const t = setup({ relays: [A] });
    const a = t.fake.socketFor(A);
    await flushOpen(a);
    const send = a.send.bind(a);
    a.send = (data) => {
      if (a.binarySent().length >= 1) throw new Error("socket gone");
      send(data);
    };
    answer(a);
    await expect(t.result).rejects.toThrow("socket gone");
    // The refused send ended the link: the socket is closed with no code.
    expect(a.closedWith).toBeNull();
  });

  it("a CSPRNG failure refuses the race and closes every socket", async () => {
    const t = setup({
      random: () => {
        throw new Error("no entropy");
      },
    });
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    a.open();
    b.open();
    await expect(t.result).rejects.toMatchObject({ code: "random-unavailable" });
    await a.whenClosed();
    await b.whenClosed();
    expect([a.closedWith, b.closedWith]).toEqual([1000, 1000]);
    expect(a.binarySent()).toHaveLength(0);
  });

  it("a relay whose socket cannot be created counts as failed; the other relay still races", async () => {
    const fake = fakeFactory();
    const t = setup({
      factory: (url) => {
        if (url.startsWith(B)) throw new Error("no socket");
        return fake.factory(url);
      },
    });
    const a = fake.socketFor(A);
    await flushOpen(a);
    answer(a);
    expect((await t.result).relay).toBe(A);

    const lone = setup({
      relays: [A],
      factory: () => {
        throw new Error("no socket");
      },
    });
    await expect(lone.result).rejects.toThrow("no socket");
  });

  it("a session close observer that throws is reported; the others still run and the socket is closed", async () => {
    const reported: Array<unknown> = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    try {
      const t = setup({ relays: [A] });
      const a = t.fake.socketFor(A);
      await flushOpen(a);
      answer(a);
      const { session } = await t.result;
      let later = false;
      session.onClose(() => {
        throw new Error("observer");
      });
      session.onClose(() => {
        later = true;
      });
      session.close(1000);
      expect(a.closedWith).toBe(1000);
      expect(later).toBe(true);
      expect(reported).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a peer close during the session's held drain waits for it: every earlier record, then the close", async () => {
    const t = setup({ relays: [A] });
    const a = t.fake.socketFor(A);
    await flushOpen(a);
    const reply = answer(a);
    const { session } = await t.result;
    a.receive(reply.send.seal(Uint8Array.of(1)));
    a.receive(reply.send.seal(Uint8Array.of(2)));
    const seen: Array<string> = [];
    session.onClose((code) => seen.push("close:" + code));
    session.onRecord((plaintext) => {
      seen.push("data:" + plaintext[0]);
      if (plaintext[0] === 1) a.remoteClose(1000);
    });
    expect(seen).toEqual(["data:1", "data:2", "close:1000"]);
  });

  it("a close observer added after the close that throws is reported, not thrown to the caller", async () => {
    const reported: Array<unknown> = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    try {
      const t = setup({ relays: [A] });
      const a = t.fake.socketFor(A);
      await flushOpen(a);
      answer(a);
      const { session } = await t.result;
      session.close(1000);
      expect(() =>
        session.onClose(() => {
          throw new Error("late observer");
        }),
      ).not.toThrow();
      expect(reported).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["held", "live"] as const)(
    "a record receiver that throws on a %s record is reported and ends the session 1011",
    async (when) => {
      const reported: Array<unknown> = [];
      vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
      try {
        const t = setup({ relays: [A] });
        const a = t.fake.socketFor(A);
        await flushOpen(a);
        const reply = answer(a);
        const { session } = await t.result;
        const receiver = () => {
          throw new Error("receiver");
        };
        if (when === "held") a.receive(reply.send.seal(Uint8Array.of(0, 1)));
        session.onRecord(receiver);
        if (when === "live") a.receive(reply.send.seal(Uint8Array.of(0, 1)));
        expect(a.closedWith).toBe(1011);
        expect(reported).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("ping race (CONTRACT Several relays, kinds 0x03 and 0x04)", () => {
  const psk = fromHex(vector.ikpsk2.psk);
  const pingOptions = {
    mode: "ping" as const,
    kind: Kind.Join,
    psk,
    payload: { v: 1, stream: "join", invite: "x", name: "p" },
  };
  const answerJoin = (socket: FakeSocket) => {
    const message1 = socket.binarySent()[0] ?? new Uint8Array();
    socket.receive(
      respond({
        kind: Kind.Join,
        nodeId: NODE,
        localStatic: serverKey,
        message1,
        psk: () => psk,
        random,
      }).message2,
    );
  };

  it("the first pong wins; the other socket closes 1000 having sent only ping; message 1 goes to the winner only", async () => {
    const t = setup(pingOptions);
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    expect(a.textSent()).toEqual(["ping"]);
    b.receive("pong");
    await a.whenClosed();
    expect(a.closedWith).toBe(1000);
    expect(a.binarySent()).toHaveLength(0);
    await b.whenSent(2);
    answerJoin(b);
    expect((await t.result).relay).toBe(B);
  });

  it("a winner whose handshake ends 4404 is dropped and the remaining relay is raced again; a 4401 ends the attempt", async () => {
    const t = setup(pingOptions);
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    a.receive("pong");
    await b.whenClosed();
    await a.whenSent(2);
    a.remoteClose(4404);
    const b2 = await t.fake.whenSocket(3);
    expect(b2.url.startsWith(B)).toBe(true);
    await flushOpen(b2);
    b2.receive("pong");
    await b2.whenSent(2);
    b2.remoteClose(4401);
    await expect(t.result).rejects.toMatchObject({ closeCode: 4401 });
  });

  it("relays that open but never answer ping: the race ends at 15 s and closes them 1000", async () => {
    const t = setup(pingOptions);
    const a = t.fake.socketFor(A);
    const b = t.fake.socketFor(B);
    await flushOpen(a, b);
    t.clock.advance(15_000);
    await expect(t.result).rejects.toMatchObject({ code: "dial-timeout" });
    expect([a.closedWith, b.closedWith]).toEqual([1000, 1000]);
  });

  it("a key confirmation that cannot be sent fails the race and closes the winner", async () => {
    const t = setup({ ...pingOptions, relays: [A] });
    const a = t.fake.socketFor(A);
    await flushOpen(a);
    a.receive("pong");
    await a.whenSent(2);
    const send = a.send.bind(a);
    a.send = (data) => {
      if (typeof data !== "string" && a.binarySent().length >= 1) throw new Error("socket gone");
      send(data);
    };
    answerJoin(a);
    await expect(t.result).rejects.toThrow("socket gone");
    // The refused send ended the link: the socket is closed with no code.
    expect(a.closedWith).toBeNull();
  });
});
