// Noise IK and IKpsk2 initiator for Pen sessions (CONTRACT "Sessions", "Record layer"), with the handshake hash exposed.
import { asciiEncode, concatBytes, equalBytes, utf8Encode } from "./bytes.ts";
import {
  aeadOpen,
  aeadSeal,
  blake2sHash,
  generateX25519,
  hmacBlake2s,
  type KeyPair,
  KEY_LENGTH,
  TAG_LENGTH,
  x25519Shared,
} from "./crypto.ts";
import { PenError } from "./errors.ts";
import type { Random } from "./runtime.ts";

export const Kind = { Session: 0x01, Join: 0x03, Account: 0x04 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const MAX_PLAINTEXT = 65_519;
/** A record's largest ciphertext: the plaintext cap plus the 16-byte tag. */
export const MAX_CIPHERTEXT = MAX_PLAINTEXT + 16;
export const REKEY_INTERVAL = 2 ** 20;
export const MAX_FIRST_MESSAGE = 4096;
export const MAX_PAYLOAD = 256;

const MESSAGE2_PAYLOAD = asciiEncode('{"v":1}\n');
const EMPTY = new Uint8Array(0);

/** "pen/1" || nodeId || kind. */
export function prologue(nodeId: string, kind: Kind): Uint8Array {
  return concatBytes(asciiEncode("pen/1" + nodeId), Uint8Array.of(kind));
}

/** One JSON object as one line (UTF-8 + LF), at most 256 bytes. */
export function encodePayloadLine(value: Readonly<Record<string, unknown>>): Uint8Array {
  const line = utf8Encode(JSON.stringify(value) + "\n");
  if (line.length > MAX_PAYLOAD) {
    throw new PenError("payload-too-large", "a handshake payload is at most 256 bytes");
  }
  return line;
}

/**
 * Transport cipher for one direction. REKEY() follows the message that makes n a multiple of 2^20 and n keeps
 * counting (CONTRACT Record layer; Go session.go Send/Recv). n stops at 2^53 - 1, which no session reaches.
 */
export class CipherState {
  #key: Uint8Array;
  #n: number;

  constructor(key: Uint8Array, n = 0) {
    if (key.length !== KEY_LENGTH) throw new PenError("key-invalid", "cipher key is not 32 bytes");
    this.#key = key.slice();
    this.#n = n;
  }

  get nonce(): number {
    return this.#n;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_PLAINTEXT) {
      throw new PenError("record-too-large", "a record carries at most 65,519 plaintext bytes");
    }
    this.#checkNonce();
    const sealed = aeadSeal(this.#key, this.#n, EMPTY, plaintext);
    this.#advance();
    return sealed;
  }

  open(ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length > MAX_CIPHERTEXT) {
      throw new PenError("record-too-large", "a record carries at most 65,519 plaintext bytes", {
        closeCode: 4400,
      });
    }
    this.#checkNonce();
    const plaintext = aeadOpen(this.#key, this.#n, EMPTY, ciphertext);
    this.#advance();
    return plaintext;
  }

  #checkNonce(): void {
    if (this.#n >= Number.MAX_SAFE_INTEGER) {
      throw new PenError("nonce-exhausted", "the session reached its last nonce", {
        closeCode: 4400,
      });
    }
  }

  #advance(): void {
    this.#n += 1;
    if (this.#n % REKEY_INTERVAL === 0) {
      this.#key = aeadSeal(this.#key, "max", EMPTY, new Uint8Array(KEY_LENGTH)).subarray(
        0,
        KEY_LENGTH,
      );
    }
  }
}

/** A transport cipher starting at nonce n: for boundary tests only. */
export function cipherStateAt(key: Uint8Array, n: number): CipherState {
  return new CipherState(key, n);
}

// Noise symmetric state over BLAKE2s (HASHLEN 32) and ChaChaPoly.
export class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  #k: Uint8Array | undefined;
  #n = 0;

  constructor(protocolName: string) {
    const name = asciiEncode(protocolName);
    this.h =
      name.length <= 32 ? concatBytes(name, new Uint8Array(32 - name.length)) : blake2sHash(name);
    this.ck = this.h;
  }

  mixHash(data: Uint8Array): void {
    this.h = blake2sHash(this.h, data);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.#k = k;
    this.#n = 0;
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, h, k] = hkdf3(this.ck, ikm);
    this.ck = ck;
    this.mixHash(h);
    this.#k = k;
    this.#n = 0;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const out = this.#k === undefined ? plaintext : aeadSeal(this.#k, this.#n++, this.h, plaintext);
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const out =
      this.#k === undefined ? ciphertext : aeadOpen(this.#k, this.#n++, this.h, ciphertext);
    this.mixHash(ciphertext);
    return out;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

// Noise HKDF over HMAC-BLAKE2s, two or three outputs.
function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmacBlake2s(chainingKey, ikm);
  const out1 = hmacBlake2s(temp, Uint8Array.of(1));
  return [out1, hmacBlake2s(temp, out1, Uint8Array.of(2))];
}

function hkdf3(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const temp = hmacBlake2s(chainingKey, ikm);
  const [out1, out2] = hkdf2(chainingKey, ikm);
  return [out1, out2, hmacBlake2s(temp, out2, Uint8Array.of(3))];
}

export function protocolName(kind: Kind): string {
  return kind === Kind.Join
    ? "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s"
    : "Noise_IK_25519_ChaChaPoly_BLAKE2s";
}

export interface InitiatorOptions {
  readonly kind: Kind;
  /** The responder's 26-character node id. */
  readonly nodeId: string;
  /** The responder's pinned Noise static key. */
  readonly remoteStatic: Uint8Array;
  readonly localStatic: KeyPair;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Required for kind 0x03 (IKpsk2), refused otherwise. */
  readonly psk?: Uint8Array;
  readonly random: Random;
}

/** Keys after a verified message 2; the key confirmation is send.seal(empty), the initiator's message 0. */
export interface SessionKeys {
  readonly handshakeHash: Uint8Array;
  readonly send: CipherState;
  readonly recv: CipherState;
}

export interface Initiator {
  /** The kind byte followed by Noise message 1. */
  readonly message1: Uint8Array;
  /** Verifies message 2; anything else is bad-message-2 (4400), which may be a relay's forgery. */
  readMessage2(message2: Uint8Array): SessionKeys;
}

export function startInitiator(options: InitiatorOptions): Initiator {
  const { kind, remoteStatic, localStatic } = options;
  const psk = kind === Kind.Join ? options.psk : undefined;
  if (kind === Kind.Join && (psk === undefined || psk.length !== KEY_LENGTH)) {
    throw new PenError("psk-invalid", "kind 0x03 needs a 32-byte psk");
  }
  if (kind !== Kind.Join && options.psk !== undefined) {
    throw new PenError("psk-invalid", "only kind 0x03 takes a psk");
  }
  if (remoteStatic.length !== KEY_LENGTH)
    throw new PenError("key-invalid", "responder key is not 32 bytes");
  const line = encodePayloadLine(options.payload);
  const ephemeral = generateX25519(options.random);

  const state = new SymmetricState(protocolName(kind));
  state.mixHash(prologue(options.nodeId, kind));
  state.mixHash(remoteStatic);
  // -> e, es, s, ss
  state.mixHash(ephemeral.publicKey);
  if (psk !== undefined) state.mixKey(ephemeral.publicKey);
  state.mixKey(x25519Shared(ephemeral.privateKey, remoteStatic));
  const encryptedStatic = state.encryptAndHash(localStatic.publicKey);
  state.mixKey(x25519Shared(localStatic.privateKey, remoteStatic));
  const encryptedPayload = state.encryptAndHash(line);
  const message1 = concatBytes(
    Uint8Array.of(kind),
    ephemeral.publicKey,
    encryptedStatic,
    encryptedPayload,
  );
  if (message1.length > MAX_FIRST_MESSAGE) {
    throw new PenError("payload-too-large", "a first message is at most 4,096 bytes");
  }

  let used = false;
  return {
    message1,
    readMessage2(message2) {
      if (used) throw new PenError("handshake-used", "message 2 was already read");
      used = true;
      const bad = (cause?: unknown) =>
        new PenError("bad-message-2", "message 2 did not verify", { closeCode: 4400, cause });
      if (message2.length !== KEY_LENGTH + MESSAGE2_PAYLOAD.length + TAG_LENGTH) throw bad();
      try {
        // <- e, ee, se (, psk)
        const remoteEphemeral = message2.subarray(0, KEY_LENGTH);
        state.mixHash(remoteEphemeral);
        if (psk !== undefined) state.mixKey(remoteEphemeral);
        state.mixKey(x25519Shared(ephemeral.privateKey, remoteEphemeral));
        state.mixKey(x25519Shared(localStatic.privateKey, remoteEphemeral));
        if (psk !== undefined) state.mixKeyAndHash(psk);
        const payload = state.decryptAndHash(message2.subarray(KEY_LENGTH));
        if (!equalBytes(payload, MESSAGE2_PAYLOAD)) throw bad();
      } catch (cause) {
        if (cause instanceof PenError && cause.code === "bad-message-2") throw cause;
        throw bad(cause);
      }
      const [send, recv] = state.split();
      return { handshakeHash: state.h.slice(), send, recv };
    },
  };
}
