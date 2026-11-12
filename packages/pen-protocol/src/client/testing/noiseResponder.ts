// A Noise IK/IKpsk2 responder for tests only: it plays the Pen daemon's side so client tests can run whole sessions.
// Its correctness is pinned by vectors/session.json (it must write the vector's message 2).
import { asciiEncode, concatBytes } from "../bytes.ts";
import { generateX25519, type KeyPair, KEY_LENGTH, x25519Shared } from "../crypto.ts";
import { PenError } from "../errors.ts";
import { type CipherState, Kind, prologue, protocolName, SymmetricState } from "../noise.ts";
import type { Random } from "../runtime.ts";

export interface ResponderAnswer {
  readonly payload: Record<string, unknown>;
  readonly remoteStatic: Uint8Array;
  readonly message2: Uint8Array;
  readonly handshakeHash: Uint8Array;
  readonly send: CipherState;
  readonly recv: CipherState;
}

export function respond(options: {
  readonly kind: Kind;
  readonly nodeId: string;
  readonly localStatic: KeyPair;
  readonly message1: Uint8Array;
  readonly psk: (payload: Record<string, unknown>) => Uint8Array | undefined;
  readonly random: Random;
  readonly payload2?: Uint8Array;
}): ResponderAnswer {
  const { kind, localStatic, message1 } = options;
  if (message1[0] !== kind) throw new PenError("kind-mismatch", "message 1 has another kind byte");
  const state = new SymmetricState(protocolName(kind));
  state.mixHash(prologue(options.nodeId, kind));
  state.mixHash(localStatic.publicKey);
  const body = message1.subarray(1);
  const remoteEphemeral = body.subarray(0, KEY_LENGTH);
  state.mixHash(remoteEphemeral);
  const join = kind === Kind.Join;
  if (join) state.mixKey(remoteEphemeral);
  state.mixKey(x25519Shared(localStatic.privateKey, remoteEphemeral));
  const remoteStatic = state.decryptAndHash(body.subarray(KEY_LENGTH, KEY_LENGTH + 48));
  state.mixKey(x25519Shared(localStatic.privateKey, remoteStatic));
  const line = state.decryptAndHash(body.subarray(KEY_LENGTH + 48));
  const payload = JSON.parse(new TextDecoder().decode(line)) as Record<string, unknown>;
  const psk = options.psk(payload);
  const ephemeral = generateX25519(options.random);
  state.mixHash(ephemeral.publicKey);
  if (join) state.mixKey(ephemeral.publicKey);
  state.mixKey(x25519Shared(ephemeral.privateKey, remoteEphemeral));
  state.mixKey(x25519Shared(ephemeral.privateKey, remoteStatic));
  if (join) {
    if (psk === undefined) throw new PenError("psk-invalid", "kind 0x03 needs a psk");
    state.mixKeyAndHash(psk);
  }
  const encrypted = state.encryptAndHash(options.payload2 ?? asciiEncode('{"v":1}\n'));
  const [initiatorToResponder, responderToInitiator] = state.split();
  return {
    payload,
    remoteStatic,
    message2: concatBytes(ephemeral.publicKey, encrypted),
    handshakeHash: state.h.slice(),
    send: responderToInitiator,
    recv: initiatorToResponder,
  };
}
