// S6 harness: Noise handshake time and record throughput for the Pen client crypto.
// The S6 bench body, free of Node built-ins so hermes-check.ts can bundle it for Hermes. bench-noise.ts runs it on Node.
import { generateX25519 } from "../src/client/crypto.ts";
import { Kind, startInitiator } from "../src/client/noise.ts";
import { respond } from "../src/client/testing/noiseResponder.ts";

export interface BenchResult {
  readonly handshakeMs: number;
  readonly sealMBps16k: number;
  readonly sealMBps64k: number;
  readonly openMBps64k: number;
}

export function runBench(now: () => number, random: (n: number) => Uint8Array): BenchResult {
  const server = generateX25519(random);
  const phone = generateX25519(random);
  const nodeId = "cc5gqlek2e2rhfy6rnliqgvlrm";
  const handshakes = 50;
  let keys = undefined as ReturnType<ReturnType<typeof startInitiator>["readMessage2"]> | undefined;
  let peer = undefined as ReturnType<typeof respond> | undefined;
  const t0 = now();
  for (let i = 0; i < handshakes; i++) {
    const initiator = startInitiator({
      kind: Kind.Session,
      nodeId,
      remoteStatic: server.publicKey,
      localStatic: phone,
      payload: { v: 1, stream: "service", name: "goat" },
      random,
    });
    peer = respond({
      kind: Kind.Session,
      nodeId,
      localStatic: server,
      message1: initiator.message1,
      psk: () => undefined,
      random,
    });
    keys = initiator.readMessage2(peer.message2);
  }
  // Both sides' work is timed, so the phone's own share is about half of this.
  const handshakeMs = (now() - t0) / handshakes;
  if (keys === undefined || peer === undefined) throw new Error("no handshake ran");
  const throughput = (size: number, total: number, step: (record: Uint8Array) => void) => {
    const record = new Uint8Array(size);
    const count = Math.ceil(total / size);
    const start = now();
    for (let i = 0; i < count; i++) step(record);
    return (count * size) / 1e6 / ((now() - start) / 1000);
  };
  // Every sealed record is kept so the peer opens them in nonce order.
  const sealed: Array<Uint8Array> = [];
  const sealMBps16k = throughput(16 * 1024, 8 * 1024 * 1024, (r) => sealed.push(keys.send.seal(r)));
  for (const record of sealed.splice(0)) peer.recv.open(record);
  const sealMBps64k = throughput(65_519, 8 * 1024 * 1024, (r) => sealed.push(keys.send.seal(r)));
  let at = 0;
  const openMBps64k = throughput(65_519, 8 * 1024 * 1024, () =>
    peer.recv.open(sealed[at++] ?? new Uint8Array()),
  );
  return { handshakeMs, sealMBps16k, sealMBps64k, openMBps64k };
}
