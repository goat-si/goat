// The phone's side of pairing (design 5.2 steps 2 to 8, 5.6 and 6.2): keys, outcomes and recovery.
// Every key change is one atomic save of the server's whole record, so a crash leaves a listed state.
import { fromBase64Url, toBase64Url } from "./bytes.ts";
import { generateX25519, type KeyPair, x25519PublicKey } from "./crypto.ts";
import { PenError } from "./errors.ts";
import {
  pairingCode,
  pairingSas,
  type PairQr,
  serviceInviteId,
  servicePsk,
  GOAT_SERVICE,
} from "./pairing.ts";
import type { Clock, Random } from "./runtime.ts";

/** How long Checking probes after an unconfirmed 202, and how often. */
export const CHECKING_WINDOW_MS = 10 * 60_000;
export const PROBE_INTERVAL_MS = 30_000;

export interface StoredKey {
  readonly privateKey: string;
  readonly publicKey: string;
}

/** The pinned server: its node id, Noise key (base64url) and the relay origins the phone may dial. */
export interface ServerPin {
  readonly nodeId: string;
  readonly noisePub: string;
  readonly relays: ReadonlyArray<string>;
}

export interface Pairing {
  readonly key: StoredKey;
  /** Null when the 200 was lost and the pairing was confirmed by an issued session. */
  readonly deviceId: string | null;
  readonly server: ServerPin;
}

export interface PendingPairing {
  readonly key: StoredKey;
  readonly stage: "pre-202" | "post-202";
  readonly server: ServerPin;
  /** The QR secret S, kept only until the pairing request is sent. */
  readonly secret?: string;
  readonly startedAt: number;
  readonly replacesDeviceId?: string;
}

/** One record per server node id; the store replaces it whole and atomically. */
export interface PairingRecord {
  readonly current?: Pairing;
  readonly pending?: PendingPairing;
  readonly previous?: Pairing;
}

export interface PairingStore {
  load(nodeId: string): Promise<PairingRecord | undefined>;
  save(nodeId: string, record: PairingRecord): Promise<void>;
  remove(nodeId: string): Promise<void>;
}

/** Answers on the pairing stream; each is authenticated because it arrives inside the Noise session. */
export type PairResponse =
  | { readonly status: 202 }
  | { readonly status: 204 }
  | {
      readonly status: 200;
      readonly deviceId: string;
      readonly environmentId: string;
      readonly label: string;
    }
  | { readonly status: 409; readonly reason: string };

/** The winning pairing session (kind 0x03, service-pair) with HTTP over its stream. */
export interface PairingChannel {
  readonly handshakeHash: Uint8Array;
  /** POST /api/pen/pair. Rejects when the stream breaks: that is not an outcome. */
  request(body: PairRequestBody): Promise<PairResponse>;
  /** GET /api/pen/pair/result, held at most 25 s by the server. Rejects when the stream breaks. */
  poll(): Promise<PairResponse>;
  close(): void;
}

export interface PairRequestBody {
  readonly name: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly replacesDeviceId?: string;
}

/** Whether a kind 0x01 client session was issued for the key over a Noise session with the pinned server key. */
export type ProbeResult =
  | { readonly issued: true; readonly deviceId?: string }
  | { readonly issued: false };

export type PairingView =
  | { readonly tag: "dialling"; readonly replacing: boolean }
  | { readonly tag: "requesting" }
  | { readonly tag: "code"; readonly code: string }
  | { readonly tag: "checking"; readonly until: number }
  | { readonly tag: "paired"; readonly deviceId: string | null }
  | { readonly tag: "refused"; readonly reason: string }
  | { readonly tag: "not-paired"; readonly reason: string }
  | { readonly tag: "not-confirmed" }
  | { readonly tag: "connect-once" }
  | { readonly tag: "pending-unresolved" }
  | { readonly tag: "discarded" };

export interface PairingDeps {
  readonly store: PairingStore;
  readonly random: Random;
  readonly clock: Clock;
  readonly device: {
    readonly name: string;
    readonly platform: string;
    readonly appVersion: string;
  };
  openPairing(input: {
    readonly qr: PairQr;
    readonly key: KeyPair;
    readonly inviteId: string;
    readonly psk: Uint8Array;
  }): Promise<PairingChannel>;
  probe(input: { readonly server: ServerPin; readonly key: KeyPair }): Promise<ProbeResult>;
  show(view: PairingView): void;
}

function storeKey(pair: KeyPair): StoredKey {
  return { privateKey: toBase64Url(pair.privateKey), publicKey: toBase64Url(pair.publicKey) };
}

function loadKey(key: StoredKey): KeyPair {
  const privateKey = fromBase64Url(key.privateKey);
  if (privateKey === null || privateKey.length !== 32)
    throw new PenError("key-invalid", "stored key is damaged");
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

// Record transitions (design table in 020): pure, so each is exactly one save.
function promote(record: PairingRecord, deviceId: string | null): PairingRecord {
  const pending = record.pending;
  if (pending === undefined) return record;
  const previous = record.current ?? record.previous;
  return {
    current: { key: pending.key, deviceId, server: pending.server },
    ...(previous === undefined ? {} : { previous }),
  };
}

function withoutPending(record: PairingRecord): PairingRecord {
  const { pending: _pending, ...rest } = record;
  return rest;
}

function finish(deps: PairingDeps, view: PairingView): PairingView {
  deps.show(view);
  return view;
}

async function saveOrRemove(
  deps: PairingDeps,
  nodeId: string,
  record: PairingRecord,
): Promise<void> {
  if (
    record.current === undefined &&
    record.pending === undefined &&
    record.previous === undefined
  ) {
    await deps.store.remove(nodeId);
  } else {
    await deps.store.save(nodeId, record);
  }
}

/** Removes the pending key after a refusal or a failure before any 202; a failure here is retried at start-up. */
async function dropPending(deps: PairingDeps, nodeId: string): Promise<void> {
  const record = (await deps.store.load(nodeId)) ?? {};
  await saveOrRemove(deps, nodeId, withoutPending(record)).catch(() => undefined);
}

/** Pairs this phone with the server named by a scanned QR. Returns the final view (also shown). */
export async function runPairing(deps: PairingDeps, qr: PairQr): Promise<PairingView> {
  const record = (await deps.store.load(qr.nodeId)) ?? {};
  if (record.pending?.stage === "post-202") return finish(deps, { tag: "pending-unresolved" });
  const replacing = record.current !== undefined;
  if (record.current !== undefined && record.current.deviceId === null) {
    return finish(deps, { tag: "connect-once" });
  }
  let key: KeyPair;
  try {
    key = generateX25519(deps.random);
  } catch {
    return finish(deps, { tag: "not-paired", reason: "this phone could not create a key" });
  }
  const server: ServerPin = {
    nodeId: qr.nodeId,
    noisePub: toBase64Url(qr.serverNoisePub),
    relays: [...qr.relays],
  };
  const replacesDeviceId = record.current?.deviceId ?? undefined;
  const pending: PendingPairing = {
    key: storeKey(key),
    stage: "pre-202",
    server,
    secret: toBase64Url(qr.secret),
    startedAt: deps.clock.now(),
    ...(replacesDeviceId === undefined ? {} : { replacesDeviceId }),
  };
  try {
    await deps.store.save(qr.nodeId, { ...withoutPending(record), pending });
  } catch {
    return finish(deps, { tag: "not-paired", reason: "this phone could not store its key" });
  }

  deps.show({ tag: "dialling", replacing });
  let channel: PairingChannel;
  try {
    channel = await deps.openPairing({
      qr,
      key,
      inviteId: serviceInviteId(qr.secret),
      psk: servicePsk(qr.secret, qr.nodeId, qr.serverNoisePub, GOAT_SERVICE),
    });
  } catch {
    await dropPending(deps, qr.nodeId);
    return finish(deps, { tag: "not-paired", reason: "could not reach the server for pairing" });
  }

  const { secret: _secret, ...requested } = pending;
  let answer: PairResponse;
  try {
    await deps.store.save(qr.nodeId, { ...withoutPending(record), pending: requested });
    deps.show({ tag: "requesting" });
    answer = await channel.request({
      ...deps.device,
      ...(replacesDeviceId === undefined ? {} : { replacesDeviceId }),
    });
  } catch {
    channel.close();
    await dropPending(deps, qr.nodeId);
    return finish(deps, {
      tag: "not-paired",
      reason: "the pairing stream closed before the server answered",
    });
  }
  if (answer.status === 409) {
    channel.close();
    await dropPending(deps, qr.nodeId);
    return finish(deps, { tag: "refused", reason: answer.reason });
  }
  if (answer.status !== 202) {
    channel.close();
    await dropPending(deps, qr.nodeId);
    return finish(deps, { tag: "not-paired", reason: "unexpected answer " + answer.status });
  }

  // The marker comes before the code: a code can only be typed after it, so before it nothing can have committed.
  try {
    await deps.store.save(qr.nodeId, {
      ...withoutPending(record),
      pending: { ...requested, stage: "post-202" },
    });
  } catch {
    channel.close();
    await dropPending(deps, qr.nodeId);
    return finish(deps, { tag: "not-paired", reason: "this phone could not record the pairing" });
  }
  deps.show({ tag: "code", code: pairingCode(pairingSas(channel.handshakeHash)) });

  for (;;) {
    let result: PairResponse;
    try {
      result = await channel.poll();
    } catch {
      channel.close();
      return checking(deps, qr.nodeId);
    }
    if (result.status === 204) continue;
    channel.close();
    if (result.status === 200) {
      const latest = (await deps.store.load(qr.nodeId)) ?? {};
      await deps.store.save(qr.nodeId, promote(latest, result.deviceId));
      return finish(deps, { tag: "paired", deviceId: result.deviceId });
    }
    if (result.status === 409) {
      await dropPending(deps, qr.nodeId);
      return finish(deps, { tag: "refused", reason: result.reason });
    }
    return checking(deps, qr.nodeId);
  }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimer(ms, resolve));
}

/** Design 5.6: after a 202 with no authenticated outcome, probe the pending key every 30 s for 10 minutes. */
async function checking(deps: PairingDeps, nodeId: string): Promise<PairingView> {
  const record = await deps.store.load(nodeId);
  const pending = record?.pending;
  if (pending === undefined)
    return finish(deps, { tag: "not-paired", reason: "no pairing in progress" });
  const key = loadKey(pending.key);
  const start = deps.clock.now();
  const until = start + CHECKING_WINDOW_MS;
  deps.show({ tag: "checking", until });
  for (let at = start; ; at += PROBE_INTERVAL_MS) {
    const result = await deps
      .probe({ server: pending.server, key })
      .catch((): ProbeResult => ({ issued: false }));
    if (result.issued) {
      const latest = (await deps.store.load(nodeId)) ?? {};
      await deps.store.save(nodeId, promote(latest, result.deviceId ?? null));
      return finish(deps, { tag: "paired", deviceId: result.deviceId ?? null });
    }
    const next = at + PROBE_INTERVAL_MS;
    if (next >= until) {
      await sleep(deps.clock, until - deps.clock.now());
      return finish(deps, { tag: "not-confirmed" });
    }
    await sleep(deps.clock, next - deps.clock.now());
  }
}

/** Retry from NotConfirmed: ten more minutes of probes. */
export function retryChecking(deps: PairingDeps, nodeId: string): Promise<PairingView> {
  return checking(deps, nodeId);
}

/** The person's Discard: removes only the pending key. */
export async function discardPairing(deps: PairingDeps, nodeId: string): Promise<PairingView> {
  const record = (await deps.store.load(nodeId)) ?? {};
  await saveOrRemove(deps, nodeId, withoutPending(record));
  return finish(deps, { tag: "discarded" });
}

/** The person's Forget <server> on this phone: removes every key for that server. */
export async function forgetServer(deps: PairingDeps, nodeId: string): Promise<void> {
  await deps.store.remove(nodeId);
}

/** Start-up recovery for one server's record. */
export async function resumePairing(
  deps: PairingDeps,
  nodeId: string,
): Promise<PairingView | undefined> {
  const record = await deps.store.load(nodeId);
  if (record === undefined) return undefined;
  if (record.pending?.stage === "pre-202") {
    await saveOrRemove(deps, nodeId, withoutPending(record));
    return finish(deps, { tag: "not-paired", reason: "interrupted before the server answered" });
  }
  if (record.pending?.stage === "post-202") return checking(deps, nodeId);
  if (record.current !== undefined)
    return finish(deps, { tag: "paired", deviceId: record.current.deviceId });
  return undefined;
}

/**
 * Called by the connection layer when a client session is issued. A session for the current key ends the
 * replacement (the previous key is removed) and fills a missing device id when the server reports it.
 */
export async function noteSessionIssued(
  deps: Pick<PairingDeps, "store">,
  nodeId: string,
  publicKey: Uint8Array,
  deviceId?: string,
): Promise<void> {
  const record = await deps.store.load(nodeId);
  const current = record?.current;
  if (
    record === undefined ||
    current === undefined ||
    current.key.publicKey !== toBase64Url(publicKey)
  )
    return;
  if (record.previous === undefined && (current.deviceId !== null || deviceId === undefined))
    return;
  const { previous: _previous, ...rest } = record;
  await deps.store.save(nodeId, {
    ...rest,
    current: { ...current, deviceId: current.deviceId ?? deviceId ?? null },
  });
}
