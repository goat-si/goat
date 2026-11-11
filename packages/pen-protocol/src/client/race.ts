// Opening a Pen session over the relays (CONTRACT "Several relays"): the handshake race for kind 0x01 (Go
// daemon/race.go openSessionVia) and the ping race for kinds 0x03 and 0x04 (Go relay/socket.go Racer.Dial).
import type { KeyPair } from "./crypto.ts";
import { PenError } from "./errors.ts";
import { type Kind, type SessionKeys, startInitiator } from "./noise.ts";
import {
  dialRelay,
  type PendingDial,
  type RelayLink,
  type RelaySocketFactory,
} from "./relayClient.ts";
import type { Clock, Random, Timer } from "./runtime.ts";

export const RACE_LIMITS = {
  /** Bounds the dials of a race (Go relay.DialRaceTimeout). */
  dialMs: 15_000,
  /** Each connected socket's handshake, from message 1 to a verified message 2 (Go session.HandshakeTimeout). */
  handshakeMs: 10_000,
  /** Records held before the stream takes the session. */
  heldRecords: 64,
  heldBytes: 1024 * 1024,
} as const;

/**
 * The race kind 0x03 service-pair uses. Design 5.2 races message 1 on every relay; CONTRACT v1.2 gives kind 0x03 the
 * ping race. Q-P's v1.3 contract text settles it (design finding F3).
 */
export const SERVICE_PAIR_RACE: "handshake" | "ping" = "handshake";

export interface SessionOptions {
  /** Relay origins (normalized wss origins). */
  readonly relays: ReadonlyArray<string>;
  readonly nodeId: string;
  readonly serverNoisePub: Uint8Array;
  readonly kind: Kind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly psk?: Uint8Array;
  readonly localStatic: KeyPair;
  readonly factory: RelaySocketFactory;
  readonly clock: Clock;
  readonly random: Random;
  /** "handshake" (default) races message 1 on every relay; "ping" races a text ping first. */
  readonly mode?: "handshake" | "ping";
}

export interface OpenedSession {
  readonly session: SecureSession;
  readonly relay: string;
  readonly handshakeHash: Uint8Array;
}

/** A confirmed Noise session on one relay socket: records in order, record cap and rekey, 4400 on a bad record. */
export class SecureSession {
  readonly closed: Promise<number>;
  readonly link: RelayLink;
  readonly keys: SessionKeys;
  #held: Array<Uint8Array> = [];
  #heldBytes = 0;
  #onRecord: ((plaintext: Uint8Array) => void) | undefined;
  #onClose: Array<(code: number) => void> = [];
  #closedCode: number | undefined;

  constructor(link: RelayLink, keys: SessionKeys) {
    this.link = link;
    this.keys = keys;
    this.closed = link.closed;
    link.attach(
      (message) => this.#onMessage(message),
      (code) => this.#onLinkClose(code),
    );
  }

  #onMessage(message: Uint8Array): void {
    let plaintext: Uint8Array;
    try {
      plaintext = this.keys.recv.open(message);
    } catch {
      this.close(4400);
      return;
    }
    if (this.#onRecord !== undefined) {
      this.#onRecord(plaintext);
      return;
    }
    if (
      this.#held.length >= RACE_LIMITS.heldRecords ||
      this.#heldBytes + plaintext.length > RACE_LIMITS.heldBytes
    ) {
      this.close(4408);
      return;
    }
    this.#held.push(plaintext);
    this.#heldBytes += plaintext.length;
  }

  #onLinkClose(code: number): void {
    this.#closedCode = code;
    for (const fn of this.#onClose.splice(0)) fn(code);
  }

  /** Takes the session's records, held ones first. */
  onRecord(handler: (plaintext: Uint8Array) => void): void {
    this.#onRecord = handler;
    for (const record of this.#held.splice(0)) handler(record);
    this.#heldBytes = 0;
  }

  onClose(handler: (code: number) => void): void {
    if (this.#closedCode !== undefined) handler(this.#closedCode);
    else this.#onClose.push(handler);
  }

  send(plaintext: Uint8Array): void {
    this.link.send(this.keys.send.seal(plaintext));
  }

  writable(): Promise<void> {
    return this.link.writable();
  }

  close(code: number): void {
    this.link.close(code);
  }
}

const isClose = (error: unknown): number | undefined =>
  error instanceof PenError && error.code === "relay-closed" ? error.closeCode : undefined;

/** A close only the node sends: 4401, or 4400 from the far side. A local bad-message-2 is not one (it may be forged). */
function nodeRefused(error: unknown): boolean {
  const code = isClose(error);
  return code === 4401 || code === 4400;
}

interface Handshaken {
  readonly keys: SessionKeys;
}

async function handshake(link: RelayLink, options: SessionOptions): Promise<Handshaken> {
  const initiator = startInitiator({
    kind: options.kind,
    nodeId: options.nodeId,
    remoteStatic: options.serverNoisePub,
    localStatic: options.localStatic,
    payload: options.payload,
    ...(options.psk === undefined ? {} : { psk: options.psk }),
    random: options.random,
  });
  link.send(initiator.message1);
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = options.clock.setTimer(RACE_LIMITS.handshakeMs, () => {
      reject(new PenError("handshake-timeout", "no message 2 within 10 s", { closeCode: 4408 }));
      link.close(4408);
    });
  });
  try {
    const message2 = await Promise.race([link.receive(), timeout]);
    try {
      return { keys: initiator.readMessage2(message2) };
    } catch (error) {
      link.close(4400);
      throw error;
    }
  } finally {
    timer?.cancel();
  }
}

/** Opens a session to nodeId over its relays, by the race the kind calls for. */
export function openSession(options: SessionOptions): Promise<OpenedSession> {
  if (options.relays.length === 0)
    return Promise.reject(new PenError("no-relays", "no relays to dial"));
  return options.mode === "ping" ? pingRace(options, options.relays) : handshakeRace(options);
}

function pickError(
  errors: ReadonlyArray<{ readonly error: unknown; readonly handshake: boolean }>,
): unknown {
  const handshakeError = errors.find((entry) => entry.handshake && isClose(entry.error) !== 4404);
  if (handshakeError !== undefined) return handshakeError.error;
  const offline = errors.find((entry) => isClose(entry.error) === 4404);
  if (offline !== undefined) return offline.error;
  return errors.at(-1)?.error ?? new PenError("dial-failed", "no relay connected");
}

function dialAll(
  options: SessionOptions,
  relays: ReadonlyArray<string>,
): Array<{ relay: string; dial: PendingDial }> {
  return relays.map((relay) => ({
    relay,
    dial: dialRelay({
      relay,
      nodeId: options.nodeId,
      factory: options.factory,
      clock: options.clock,
    }),
  }));
}

function handshakeRace(options: SessionOptions): Promise<OpenedSession> {
  return new Promise((resolve, reject) => {
    let decided = false;
    let remaining = options.relays.length;
    const errors: Array<{ error: unknown; handshake: boolean }> = [];
    const live = new Set<RelayLink>();
    const dials = dialAll(options, options.relays);
    const dialTimer = options.clock.setTimer(RACE_LIMITS.dialMs, () => {
      for (const { dial } of dials) dial.abandon();
    });
    const decide = (keep: RelayLink | undefined) => {
      decided = true;
      dialTimer.cancel();
      for (const link of live) if (link !== keep) link.close(1000);
    };
    const settle = (error: unknown, handshakeError: boolean) => {
      errors.push({ error, handshake: handshakeError });
      remaining -= 1;
      if (remaining === 0 && !decided) {
        decide(undefined);
        reject(pickError(errors));
      }
    };
    for (const { relay, dial } of dials) {
      dial.opened.then(
        async (link) => {
          // Losers finish their dial, then close 1000 (an aborted WebSocket handshake reaches the node as 1006).
          if (decided) {
            link.close(1000);
            return;
          }
          live.add(link);
          let result: Handshaken;
          try {
            result = await handshake(link, options);
          } catch (error) {
            live.delete(link);
            if (decided) return;
            if (error instanceof PenError && error.code === "random-unavailable") {
              link.close(1000);
              decide(undefined);
              reject(error);
              return;
            }
            if (nodeRefused(error)) {
              decide(undefined);
              reject(error);
              return;
            }
            link.close(1000);
            settle(error, true);
            return;
          }
          if (decided) {
            link.close(1000);
            return;
          }
          decide(link);
          try {
            link.send(result.keys.send.seal(new Uint8Array(0)));
          } catch (error) {
            link.close(1000);
            reject(error);
            return;
          }
          resolve({
            session: new SecureSession(link, result.keys),
            relay,
            handshakeHash: result.keys.handshakeHash,
          });
        },
        (error: unknown) => {
          if (!decided) settle(error, false);
        },
      );
    }
  });
}

/** The ping race: first pong wins, losers close 1000 before any other byte; message 1 only on the winner. */
async function pingRace(
  options: SessionOptions,
  relays: ReadonlyArray<string>,
): Promise<OpenedSession> {
  const winner = await new Promise<{ relay: string; link: RelayLink }>((resolve, reject) => {
    let decided = false;
    let remaining = relays.length;
    const errors: Array<{ error: unknown; handshake: boolean }> = [];
    const live = new Set<RelayLink>();
    const dials = dialAll(options, relays);
    const raceTimer = options.clock.setTimer(RACE_LIMITS.dialMs, () => {
      if (decided) return;
      decided = true;
      for (const { dial } of dials) dial.abandon();
      for (const link of live) link.close(1000);
      reject(new PenError("dial-timeout", "no relay answered within 15 s"));
    });
    const fail = (error: unknown) => {
      errors.push({ error, handshake: false });
      remaining -= 1;
      if (remaining === 0 && !decided) {
        decided = true;
        raceTimer.cancel();
        reject(pickError(errors));
      }
    };
    for (const { relay, dial } of dials) {
      dial.opened.then(
        (link) => {
          if (decided) {
            link.close(1000);
            return;
          }
          live.add(link);
          link.ping();
          const closedEarly = link.closed.then((code) => {
            throw new PenError("relay-closed", "closed " + code, { closeCode: code });
          });
          Promise.race([link.pong, closedEarly]).then(
            () => {
              if (decided) {
                link.close(1000);
                return;
              }
              decided = true;
              raceTimer.cancel();
              for (const other of live) if (other !== link) other.close(1000);
              resolve({ relay, link });
            },
            (error: unknown) => {
              live.delete(link);
              if (!decided) fail(error);
            },
          );
        },
        (error: unknown) => {
          if (!decided) fail(error);
        },
      );
    }
  });
  let result: Handshaken;
  try {
    result = await handshake(winner.link, options);
  } catch (error) {
    winner.link.close(1000);
    const badAnswer = error instanceof PenError && error.code === "bad-message-2";
    const rest = relays.filter((relay) => relay !== winner.relay);
    if (
      nodeRefused(error) ||
      badAnswer ||
      rest.length === 0 ||
      (error instanceof PenError && error.code === "random-unavailable")
    ) {
      throw error;
    }
    return pingRace(options, rest);
  }
  winner.link.send(result.keys.send.seal(new Uint8Array(0)));
  return {
    session: new SecureSession(winner.link, result.keys),
    relay: winner.relay,
    handshakeHash: result.keys.handshakeHash,
  };
}
