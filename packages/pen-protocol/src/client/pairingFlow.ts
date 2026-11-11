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
import type { Clock, Random, Timer } from "./runtime.ts";

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
  | { readonly tag: "discarded" }
  /** The outcome belonged to an attempt the person discarded or replaced; nothing changed, and it is never shown. */
  | { readonly tag: "superseded" }
  /** A replacement is waiting for the new key's first session; until then the original key is kept (§6.2). */
  | { readonly tag: "replacement-pending" };

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

// Record transitions. Each runs inside update(), which serializes all changes to one server's record, and each
// outcome is tied to its attempt by the pending key's public key: a late answer for a discarded or replaced attempt
// changes nothing.
const updates = new WeakMap<PairingStore, Map<string, Promise<unknown>>>();

/** Runs change on the latest record, one change at a time per server; undefined from change writes nothing. */
async function update<T>(
  deps: Pick<PairingDeps, "store">,
  nodeId: string,
  change: (record: PairingRecord) => { readonly next?: PairingRecord; readonly result: T },
): Promise<T> {
  let byNode = updates.get(deps.store);
  if (byNode === undefined) {
    byNode = new Map();
    updates.set(deps.store, byNode);
  }
  const before = byNode.get(nodeId) ?? Promise.resolve();
  const run = before
    .catch(() => undefined)
    .then(async () => {
      const { next, result } = change((await deps.store.load(nodeId)) ?? {});
      if (next !== undefined) await saveOrRemove(deps, nodeId, next);
      return result;
    });
  byNode.set(nodeId, run);
  try {
    return await run;
  } finally {
    if (byNode.get(nodeId) === run) byNode.delete(nodeId);
  }
}

const isAttempt = (record: PairingRecord, publicKey: string) =>
  record.pending?.key.publicKey === publicKey;

/** Promotes the attempt's pending key; false when that attempt is no longer the pending one. */
function promoteAttempt(
  deps: PairingDeps,
  nodeId: string,
  publicKey: string,
  deviceId: string | null,
) {
  return update(deps, nodeId, (record) => {
    const pending = record.pending;
    if (pending === undefined || !isAttempt(record, publicKey)) return { result: false };
    const previous = record.current ?? record.previous;
    return {
      next: {
        current: { key: pending.key, deviceId, server: pending.server },
        ...(previous === undefined ? {} : { previous }),
      },
      result: true,
    };
  });
}

/**
 * Removes the attempt's pending key after its own refusal or failure; another attempt's key is left alone
 * ("superseded"). "failed" means the store refused: the key stays, and start-up recovery removes it.
 */
async function dropPending(
  deps: PairingDeps,
  nodeId: string,
  publicKey: string,
): Promise<"dropped" | "superseded" | "failed"> {
  return update(deps, nodeId, (record) =>
    isAttempt(record, publicKey)
      ? { next: withoutPending(record), result: "dropped" as const }
      : { result: "superseded" as const },
  ).catch(() => "failed" as const);
}

/** Whether the attempt still owns the pending record after its 202, read in turn with every other change. */
function ownsChecking(deps: PairingDeps, nodeId: string, publicKey: string): Promise<boolean> {
  return update(deps, nodeId, (record) => ({
    result: isAttempt(record, publicKey) && record.pending?.stage === "post-202",
  }));
}

/** Replaces the attempt's pending entry; false when the attempt is no longer the pending one. */
function setPending(deps: PairingDeps, nodeId: string, publicKey: string, pending: PendingPairing) {
  return update(deps, nodeId, (record) =>
    isAttempt(record, publicKey)
      ? { next: { ...withoutPending(record), pending }, result: true }
      : { result: false },
  );
}

function withoutPending(record: PairingRecord): PairingRecord {
  const { pending: _pending, ...rest } = record;
  return rest;
}

function finish(deps: PairingDeps, view: PairingView): PairingView {
  deps.show(view);
  return view;
}

/** An outcome for an attempt the person discarded or replaced: returned, never shown over the newer screen. */
const SUPERSEDED: PairingView = { tag: "superseded" };

async function saveOrRemove(
  deps: Pick<PairingDeps, "store">,
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

/** Pairs this phone with the server named by a scanned QR. Returns the final view (also shown). */
export async function runPairing(deps: PairingDeps, qr: PairQr): Promise<PairingView> {
  let key: KeyPair;
  try {
    key = generateX25519(deps.random);
  } catch {
    return finish(deps, { tag: "not-paired", reason: "this phone could not create a key" });
  }
  const attempt = toBase64Url(key.publicKey);
  const server: ServerPin = {
    nodeId: qr.nodeId,
    noisePub: toBase64Url(qr.serverNoisePub),
    relays: [...qr.relays],
  };
  // The decision to start and the pending key's save are one serialized step on the latest record.
  type Start =
    | { readonly tag: "start"; readonly pending: PendingPairing; readonly replacing: boolean }
    | { readonly tag: "stop"; readonly view: PairingView };
  let start: Start;
  try {
    start = await update<Start>(deps, qr.nodeId, (record) => {
      if (record.pending?.stage === "post-202") {
        return { result: { tag: "stop", view: { tag: "pending-unresolved" } } };
      }
      if (record.current !== undefined && record.current.deviceId === null) {
        return { result: { tag: "stop", view: { tag: "connect-once" } } };
      }
      // The original key stays until the new key has had a session; a second replacement would lose it.
      if (record.previous !== undefined) {
        return { result: { tag: "stop", view: { tag: "replacement-pending" } } };
      }
      const replacesDeviceId = record.current?.deviceId ?? undefined;
      const pending: PendingPairing = {
        key: storeKey(key),
        stage: "pre-202",
        server,
        secret: toBase64Url(qr.secret),
        startedAt: deps.clock.now(),
        ...(replacesDeviceId === undefined ? {} : { replacesDeviceId }),
      };
      return {
        next: { ...withoutPending(record), pending },
        result: { tag: "start", pending, replacing: record.current !== undefined },
      };
    });
  } catch {
    return finish(deps, { tag: "not-paired", reason: "this phone could not store its key" });
  }
  if (start.tag === "stop") return finish(deps, start.view);
  const { pending } = start;
  const replacesDeviceId = pending.replacesDeviceId;

  deps.show({ tag: "dialling", replacing: start.replacing });
  let channel: PairingChannel;
  try {
    channel = await deps.openPairing({
      qr,
      key,
      inviteId: serviceInviteId(qr.secret),
      psk: servicePsk(qr.secret, qr.nodeId, qr.serverNoisePub, GOAT_SERVICE),
    });
  } catch {
    if ((await dropPending(deps, qr.nodeId, attempt)) === "superseded") return SUPERSEDED;
    return finish(deps, { tag: "not-paired", reason: "could not reach the server for pairing" });
  }

  const { secret: _secret, ...requested } = pending;
  let answer: PairResponse;
  try {
    if (!(await setPending(deps, qr.nodeId, attempt, requested))) {
      channel.close();
      return SUPERSEDED;
    }
    deps.show({ tag: "requesting" });
    answer = await channel.request({
      ...deps.device,
      ...(replacesDeviceId === undefined ? {} : { replacesDeviceId }),
    });
  } catch {
    channel.close();
    if ((await dropPending(deps, qr.nodeId, attempt)) === "superseded") return SUPERSEDED;
    return finish(deps, {
      tag: "not-paired",
      reason: "the pairing stream closed before the server answered",
    });
  }
  if (answer.status === 409) {
    channel.close();
    if ((await dropPending(deps, qr.nodeId, attempt)) === "superseded") return SUPERSEDED;
    return finish(deps, { tag: "refused", reason: answer.reason });
  }
  if (answer.status !== 202) {
    channel.close();
    if ((await dropPending(deps, qr.nodeId, attempt)) === "superseded") return SUPERSEDED;
    return finish(deps, { tag: "not-paired", reason: "unexpected answer " + answer.status });
  }

  // The marker comes before the code: a code can only be typed after it, so before it nothing can have committed.
  let marked: boolean;
  try {
    marked = await setPending(deps, qr.nodeId, attempt, { ...requested, stage: "post-202" });
  } catch {
    channel.close();
    if ((await dropPending(deps, qr.nodeId, attempt)) === "superseded") return SUPERSEDED;
    return finish(deps, { tag: "not-paired", reason: "this phone could not record the pairing" });
  }
  if (!marked) {
    channel.close();
    return SUPERSEDED;
  }
  deps.show({ tag: "code", code: pairingCode(pairingSas(channel.handshakeHash)) });

  for (;;) {
    let result: PairResponse;
    try {
      result = await channel.poll();
    } catch {
      channel.close();
      return checking(deps, qr.nodeId, attempt);
    }
    if (result.status === 204) {
      // A discard or a newer attempt while the poll was held ends this attempt's polling.
      if (await ownsChecking(deps, qr.nodeId, attempt)) continue;
      channel.close();
      return SUPERSEDED;
    }
    channel.close();
    if (result.status === 200) {
      if (!(await promoteAttempt(deps, qr.nodeId, attempt, result.deviceId))) return SUPERSEDED;
      return finish(deps, { tag: "paired", deviceId: result.deviceId });
    }
    if (result.status === 409) {
      if ((await dropPending(deps, qr.nodeId, attempt)) === "superseded") return SUPERSEDED;
      return finish(deps, { tag: "refused", reason: result.reason });
    }
    return checking(deps, qr.nodeId, attempt);
  }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimer(ms, resolve));
}

/** Design 5.6: after a 202 with no authenticated outcome, probe the pending key every 30 s for 10 minutes. */
async function checking(
  deps: PairingDeps,
  nodeId: string,
  expected?: string,
): Promise<PairingView> {
  const start = deps.clock.now();
  const until = start + CHECKING_WINDOW_MS;
  // Checking runs only for its own attempt, only after that attempt's 202 was recorded, and it starts (screen
  // included) in turn with every other change to the record: a discard or a newer attempt is either seen here or
  // comes after the Checking screen and is seen at the next step.
  const pending = await update(deps, nodeId, (record) => {
    const candidate = record.pending;
    const own =
      candidate !== undefined &&
      candidate.stage === "post-202" &&
      (expected === undefined || candidate.key.publicKey === expected);
    if (!own) return { result: undefined };
    deps.show({ tag: "checking", until });
    return { result: candidate };
  });
  if (pending === undefined) {
    return expected === undefined
      ? finish(deps, { tag: "not-paired", reason: "no pairing in progress" })
      : SUPERSEDED;
  }
  const attempt = pending.key.publicKey;
  const key = loadKey(pending.key);
  // One deadline for the whole window bounds every probe: one still unanswered at the end is ignored.
  let deadline: Timer | undefined;
  const expired = new Promise<"expired">((resolve) => {
    deadline = deps.clock.setTimer(Math.max(0, until - deps.clock.now()), () => resolve("expired"));
  });
  try {
    for (let at = start; ; at += PROBE_INTERVAL_MS) {
      const result = await Promise.race([
        deps.probe({ server: pending.server, key }).catch((): ProbeResult => ({ issued: false })),
        expired,
      ]);
      if (result === "expired") {
        if (!(await ownsChecking(deps, nodeId, attempt))) return SUPERSEDED;
        return finish(deps, { tag: "not-confirmed" });
      }
      if (result.issued) {
        // The session proves this attempt's key only; a discarded or replaced attempt promotes nothing.
        if (!(await promoteAttempt(deps, nodeId, attempt, result.deviceId ?? null)))
          return SUPERSEDED;
        return finish(deps, { tag: "paired", deviceId: result.deviceId ?? null });
      }
      // A discard or a newer attempt during the probe or the wait ends this Checking without a word.
      if (!(await ownsChecking(deps, nodeId, attempt))) return SUPERSEDED;
      const next = at + PROBE_INTERVAL_MS;
      if (next >= until) {
        await expired;
        if (!(await ownsChecking(deps, nodeId, attempt))) return SUPERSEDED;
        return finish(deps, { tag: "not-confirmed" });
      }
      await sleep(deps.clock, next - deps.clock.now());
      if (!(await ownsChecking(deps, nodeId, attempt))) return SUPERSEDED;
    }
  } finally {
    deadline?.cancel();
  }
}

/** Retry from NotConfirmed: ten more minutes of probes. */
export function retryChecking(deps: PairingDeps, nodeId: string): Promise<PairingView> {
  return checking(deps, nodeId);
}

/** The person's Discard: removes only the pending key. */
export async function discardPairing(deps: PairingDeps, nodeId: string): Promise<PairingView> {
  await update(deps, nodeId, (record) => ({ next: withoutPending(record), result: undefined }));
  return finish(deps, { tag: "discarded" });
}

/** The person's Forget <server> on this phone: removes every key for that server. */
export async function forgetServer(deps: PairingDeps, nodeId: string): Promise<void> {
  await update(deps, nodeId, () => ({ next: {}, result: undefined }));
}

/** Start-up recovery for one server's record. */
export async function resumePairing(
  deps: PairingDeps,
  nodeId: string,
): Promise<PairingView | undefined> {
  type Stage =
    | "dropped"
    | "none"
    | { readonly checking: string }
    | { readonly paired: PairingView };
  const stage = await update<Stage>(deps, nodeId, (record) => {
    if (record.pending?.stage === "pre-202")
      return { next: withoutPending(record), result: "dropped" };
    if (record.pending?.stage === "post-202")
      return { result: { checking: record.pending.key.publicKey } };
    if (record.current !== undefined) {
      // Shown in the same turn as the read, so a Forget can only come after it.
      return {
        result: { paired: finish(deps, { tag: "paired", deviceId: record.current.deviceId }) },
      };
    }
    return { result: "none" };
  });
  if (stage === "dropped") {
    return finish(deps, { tag: "not-paired", reason: "interrupted before the server answered" });
  }
  if (stage === "none") return undefined;
  if ("paired" in stage) return stage.paired;
  // Recovery checks the attempt it found; one that was discarded or replaced meanwhile is not adopted.
  return checking(deps, nodeId, stage.checking);
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
  const issued = toBase64Url(publicKey);
  await update(deps, nodeId, (record) => {
    const current = record.current;
    if (current === undefined || current.key.publicKey !== issued) return { result: undefined };
    if (record.previous === undefined && (current.deviceId !== null || deviceId === undefined)) {
      return { result: undefined };
    }
    const { previous: _previous, ...rest } = record;
    return {
      next: { ...rest, current: { ...current, deviceId: current.deviceId ?? deviceId ?? null } },
      result: undefined,
    };
  });
}
