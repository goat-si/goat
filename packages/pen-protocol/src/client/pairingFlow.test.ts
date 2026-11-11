import { describe, expect, it } from "vite-plus/test";
import { fromHex, toBase64Url } from "./bytes.ts";
import { generateX25519 } from "./crypto.ts";
import { pairingCode, pairingSas, type PairQr } from "./pairing.ts";
import {
  discardPairing,
  forgetServer,
  noteSessionIssued,
  type PairingChannel,
  type PairingDeps,
  type PairingRecord,
  type PairingView,
  type PairResponse,
  type ProbeResult,
  resumePairing,
  retryChecking,
  runPairing,
} from "./pairingFlow.ts";
import { ManualClock } from "./testing/manualClock.ts";

const NODE = "cc5gqlek2e2rhfy6rnliqgvlrm";
const qr: PairQr = {
  nodeId: NODE,
  serverNoisePub: fromHex("0f".repeat(32)),
  secret: fromHex("55".repeat(32)),
  expiresAt: 1_800_000_300,
  relays: ["wss://pen-relay.pos090001.workers.dev"],
};
const HASH = fromHex("27c06c9f262b5b3332ee9a05d0cd0f32b5ec535643db53883fb561249381ad17");
const CODE = pairingCode(pairingSas(HASH));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(
  options: { record?: PairingRecord; failSave?: (record: PairingRecord) => boolean } = {},
) {
  const clock = new ManualClock(1_000);
  const events: Array<string> = [];
  const watchers: Array<{ name: string; count: number; resolve: () => void }> = [];
  const emit = (name: string) => {
    events.push(name);
    for (const watcher of watchers.slice()) {
      if (events.filter((event) => event === watcher.name).length >= watcher.count) {
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    }
  };
  /** Resolves once the flow has emitted `name` `count` times. */
  const when = (name: string, count = 1) =>
    new Promise<void>((resolve) => {
      if (events.filter((event) => event === name).length >= count) resolve();
      else watchers.push({ name, count, resolve });
    });
  const views: Array<PairingView> = [];
  let stored: PairingRecord | undefined = options.record;
  let seed = 1;
  const requests: Array<unknown> = [];
  const replies = { request: deferred<PairResponse>(), polls: [] as Array<Deferred<PairResponse>> };
  const probes: Array<{ key: string; answer: Deferred<ProbeResult> }> = [];
  let opened = 0;
  const channel: PairingChannel = {
    handshakeHash: HASH,
    request: (body) => {
      requests.push(body);
      emit("request");
      return replies.request.promise;
    },
    poll: () => {
      const next = deferred<PairResponse>();
      replies.polls.push(next);
      emit("poll");
      return next.promise;
    },
    close: () => emit("close"),
  };
  const race = deferred<PairingChannel>();
  const deps: PairingDeps = {
    clock,
    random: (n) => new Uint8Array(n).fill(seed++),
    device: { name: "Jun's phone", platform: "ios", appVersion: "1.0.0" },
    store: {
      load: async () => stored,
      save: async (_nodeId, record) => {
        if (options.failSave?.(record)) throw new Error("keychain unavailable");
        emit("save:" + (record.pending?.stage ?? (record.current ? "current" : "empty")));
        stored = structuredClone(record);
      },
      remove: async () => {
        emit("remove");
        stored = undefined;
      },
    },
    openPairing: () => {
      opened += 1;
      emit("dial");
      return race.promise;
    },
    probe: ({ key }) => {
      const answer = deferred<ProbeResult>();
      probes.push({ key: toBase64Url(key.publicKey), answer });
      emit("probe");
      return answer.promise;
    },
    show: (view) => {
      views.push(view);
      emit("show:" + view.tag);
    },
  };
  return {
    clock,
    deps,
    events,
    views,
    requests,
    replies,
    probes,
    race,
    channel,
    stored: () => stored,
    opened: () => opened,
    when,
  };
}

describe("phone pairing flow (design 5.2, 5.6, 6.2)", () => {
  it("P is saved at pre-202 before the first dial; 202 saves post-202 without S before the code; 200 promotes", async () => {
    const t = setup();
    const done = runPairing(t.deps, qr);
    await t.when("dial");
    expect(t.stored()?.pending).toMatchObject({ stage: "pre-202", secret: toBase64Url(qr.secret) });
    t.race.resolve(t.channel);
    await t.when("request");
    expect(t.requests[0]).toEqual({ name: "Jun's phone", platform: "ios", appVersion: "1.0.0" });
    expect(t.stored()?.pending?.secret).toBeUndefined();
    t.replies.request.resolve({ status: 202 });
    await t.when("poll");
    expect(t.views.find((view) => view.tag === "code")).toEqual({ tag: "code", code: CODE });
    t.replies.polls[0]?.resolve({ status: 204 });
    await t.when("poll", 2);
    t.replies.polls[1]?.resolve({
      status: 200,
      deviceId: "dev1",
      environmentId: "env1",
      label: "Mac",
    });
    expect(await done).toEqual({ tag: "paired", deviceId: "dev1" });
    expect(t.events.indexOf("save:post-202")).toBeLessThan(t.events.indexOf("show:code"));
    expect(t.events.indexOf("save:pre-202")).toBeLessThan(t.events.indexOf("dial"));
    expect(t.stored()).toMatchObject({ current: { deviceId: "dev1", server: { nodeId: NODE } } });
    expect(t.stored()?.pending).toBeUndefined();
    expect(t.stored()?.current?.server.relays).toEqual(qr.relays);
  });

  it("a key store that cannot save dials nothing", async () => {
    const t = setup({ failSave: () => true });
    expect(await runPairing(t.deps, qr)).toMatchObject({ tag: "not-paired" });
    expect(t.opened()).toBe(0);
  });

  it("a CSPRNG failure saves nothing and dials nothing", async () => {
    const t = setup();
    const deps = {
      ...t.deps,
      random: () => {
        throw new Error("no entropy");
      },
    };
    expect(await runPairing(deps, qr)).toMatchObject({ tag: "not-paired" });
    expect(t.opened()).toBe(0);
    expect(t.stored()).toBeUndefined();
  });

  it("a failure before any 202 removes P and shows no code", async () => {
    const t = setup();
    const done = runPairing(t.deps, qr);
    await t.when("dial");
    t.race.reject(Object.assign(new Error("refused"), { closeCode: 4401 }));
    expect(await done).toMatchObject({ tag: "not-paired" });
    expect(t.stored()).toBeUndefined();
    expect(t.views.some((view) => view.tag === "code")).toBe(false);
  });

  it("a stream break after the request but before a 202 removes P", async () => {
    const t = setup();
    const done = runPairing(t.deps, qr);
    await t.when("dial");
    t.race.resolve(t.channel);
    await t.when("request");
    t.replies.request.reject(new Error("stream closed 4408"));
    expect(await done).toMatchObject({ tag: "not-paired" });
    expect(t.stored()).toBeUndefined();
  });

  it("an authenticated 409 removes P", async () => {
    const t = setup();
    const done = runPairing(t.deps, qr);
    await t.when("dial");
    t.race.resolve(t.channel);
    await t.when("request");
    t.replies.request.resolve({ status: 202 });
    await t.when("poll");
    t.replies.polls[0]?.resolve({ status: 409, reason: "mismatch" });
    expect(await done).toEqual({ tag: "refused", reason: "mismatch" });
    expect(t.stored()).toBeUndefined();
  });

  it("if the post-202 marker cannot be saved, no code is shown and P is removed", async () => {
    const t = setup({ failSave: (record) => record.pending?.stage === "post-202" });
    const done = runPairing(t.deps, qr);
    await t.when("dial");
    t.race.resolve(t.channel);
    await t.when("request");
    t.replies.request.resolve({ status: 202 });
    expect(await done).toMatchObject({ tag: "not-paired" });
    expect(t.views.some((view) => view.tag === "code")).toBe(false);
    expect(t.events).toContain("close");
  });

  async function toChecking(t: ReturnType<typeof setup>, done: Promise<PairingView>) {
    await t.when("dial");
    t.race.resolve(t.channel);
    await t.when("request");
    t.replies.request.resolve({ status: 202 });
    await t.when("poll");
    t.replies.polls[0]?.reject(Object.assign(new Error("closed"), { closeCode: 4401 }));
    return done;
  }

  it("after a 202 a break leads to Checking: the pending key is probed every 30 s; a session pairs it with no device id", async () => {
    const t = setup();
    const done = runPairing(t.deps, qr);
    void toChecking(t, done);
    await t.when("probe");
    const pendingKey = t.stored()?.pending?.key.publicKey;
    expect(t.views.at(-1)).toMatchObject({ tag: "checking" });
    t.probes[0]?.answer.resolve({ issued: false });
    await t.clock.nextTimer();
    t.clock.advance(30_000);
    await t.when("probe", 2);
    expect(t.probes.map((probe) => probe.key)).toEqual([pendingKey, pendingKey]);
    t.probes[1]?.answer.resolve({ issued: true });
    expect(await done).toEqual({ tag: "paired", deviceId: null });
    expect(t.stored()?.current?.key.publicKey).toBe(pendingKey);
    expect(t.stored()?.pending).toBeUndefined();
  });

  it("ten minutes of failed probes end in NotConfirmed and keep P; Retry checks again; only Discard removes P", async () => {
    const t = setup();
    const done = runPairing(t.deps, qr);
    void toChecking(t, done);
    await t.when("probe");
    // Twenty probes, at 0 s, 30 s, ... 570 s; the 600 s mark ends Checking.
    for (let i = 0; i < 20; i++) {
      t.probes[i]?.answer.resolve({ issued: false });
      await t.clock.nextTimer();
      t.clock.advance(30_000);
      if (i < 19) await t.when("probe", i + 2);
    }
    expect(await done).toEqual({ tag: "not-confirmed" });
    expect(t.probes).toHaveLength(20);
    expect(t.stored()?.pending?.stage).toBe("post-202");
    const retried = retryChecking(t.deps, NODE);
    await t.when("probe", 21);
    t.probes[20]?.answer.resolve({ issued: true });
    expect(await retried).toEqual({ tag: "paired", deviceId: null });
  });

  it("Discard removes the pending key and nothing else", async () => {
    const current = {
      key: { privateKey: "a", publicKey: "b" },
      deviceId: "old",
      server: { nodeId: NODE, noisePub: "x", relays: [] },
    };
    const t = setup({
      record: {
        current,
        pending: {
          key: { privateKey: "c", publicKey: "d" },
          stage: "post-202",
          server: current.server,
          startedAt: 0,
        },
      },
    });
    expect(await discardPairing(t.deps, NODE)).toEqual({ tag: "discarded" });
    expect(t.stored()).toEqual({ current });
  });

  it("replacement names the old device; the old key stays through the 200 and goes after the new key's first session", async () => {
    const old = generateX25519(() => new Uint8Array(32).fill(9));
    const current = {
      key: { privateKey: toBase64Url(old.privateKey), publicKey: toBase64Url(old.publicKey) },
      deviceId: "old-device",
      server: { nodeId: NODE, noisePub: toBase64Url(qr.serverNoisePub), relays: [...qr.relays] },
    };
    const t = setup({ record: { current } });
    const done = runPairing(t.deps, qr);
    await t.when("dial");
    expect(t.views[0]).toEqual({ tag: "dialling", replacing: true });
    t.race.resolve(t.channel);
    await t.when("request");
    expect(t.requests[0]).toMatchObject({ replacesDeviceId: "old-device" });
    t.replies.request.resolve({ status: 202 });
    await t.when("poll");
    t.replies.polls[0]?.resolve({
      status: 200,
      deviceId: "new-device",
      environmentId: "e",
      label: "Mac",
    });
    await done;
    expect(t.stored()?.previous).toEqual(current);
    await noteSessionIssued(t.deps, NODE, old.publicKey);
    expect(t.stored()?.previous).toEqual(current);
    const fresh = t.stored()?.current?.key.publicKey ?? "";
    await noteSessionIssued(t.deps, NODE, fromBase64UrlOrThrow(fresh));
    expect(t.stored()?.previous).toBeUndefined();
    expect(t.stored()?.current?.deviceId).toBe("new-device");
  });

  it("a replacement whose old device id is unknown stops before dialling; Forget removes current and previous", async () => {
    const pairing = {
      key: { privateKey: "a", publicKey: "b" },
      deviceId: null,
      server: { nodeId: NODE, noisePub: "x", relays: [] },
    };
    const t = setup({ record: { current: pairing, previous: { ...pairing, deviceId: "older" } } });
    expect(await runPairing(t.deps, qr)).toEqual({ tag: "connect-once" });
    expect(t.opened()).toBe(0);
    await forgetServer(t.deps, NODE);
    expect(t.stored()).toBeUndefined();
  });

  it("a scan while an earlier pairing awaits its outcome after a 202 changes nothing", async () => {
    const pending = {
      key: { privateKey: "c", publicKey: "d" },
      stage: "post-202" as const,
      server: { nodeId: NODE, noisePub: "x", relays: [] },
      startedAt: 0,
    };
    const t = setup({ record: { pending } });
    expect(await runPairing(t.deps, qr)).toEqual({ tag: "pending-unresolved" });
    expect(t.stored()).toEqual({ pending });
    expect(t.opened()).toBe(0);
  });

  it("start-up: pre-202 is removed, post-202 resumes Checking with the pending key, a promoted pairing keeps its previous key", async () => {
    const server = { nodeId: NODE, noisePub: "x", relays: [] };
    const pre = setup({
      record: {
        pending: {
          key: { privateKey: "c", publicKey: "d" },
          stage: "pre-202",
          server,
          startedAt: 0,
        },
      },
    });
    expect(await resumePairing(pre.deps, NODE)).toEqual({
      tag: "not-paired",
      reason: "interrupted before the server answered",
    });
    expect(pre.stored()).toBeUndefined();

    const pendingKey = generateX25519(() => new Uint8Array(32).fill(7));
    const post = setup({
      record: {
        pending: {
          key: {
            privateKey: toBase64Url(pendingKey.privateKey),
            publicKey: toBase64Url(pendingKey.publicKey),
          },
          stage: "post-202",
          server,
          startedAt: 0,
        },
      },
    });
    const resumed = resumePairing(post.deps, NODE);
    await post.when("probe");
    expect(post.probes[0]?.key).toBe(toBase64Url(pendingKey.publicKey));
    post.probes[0]?.answer.resolve({ issued: true, deviceId: "dev9" });
    expect(await resumed).toEqual({ tag: "paired", deviceId: "dev9" });

    const pairing = { key: { privateKey: "a", publicKey: "b" }, deviceId: "new", server };
    const promoted = setup({
      record: { current: pairing, previous: { ...pairing, deviceId: "old" } },
    });
    expect(await resumePairing(promoted.deps, NODE)).toEqual({ tag: "paired", deviceId: "new" });
    expect(promoted.stored()?.previous?.deviceId).toBe("old");
  });
});

function fromBase64UrlOrThrow(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
