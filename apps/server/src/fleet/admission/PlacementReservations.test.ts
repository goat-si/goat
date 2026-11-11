// @effect-diagnostics nodeBuiltinImport:off - each test gets a scratch database folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  ADMIT_WINDOW_MS,
  FUTURE_MS,
  LEASE_MS,
  PENDING_CAP_MS,
  PLACER_BOUND,
  RETAIN_MS,
  type AdmitInput,
  type PlacementKey,
  PlacementReservations,
  layer as reservationsLayer,
} from "./PlacementReservations.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const EPOCH = "epoch-a";

const freshFile = () =>
  NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placement-")), "state.sqlite");

const storeOn = (file: string) =>
  Layer.provideMerge(
    reservationsLayer,
    SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer)),
  );
const store = () => storeOn(freshFile());

const key = (
  ownerKey: string,
  issuedAt = T0,
  placer = "pen:node-a",
  attempt = 0,
): PlacementKey => ({
  placer,
  ownerKey,
  attempt,
  issuedAt,
});

const admitInput = (k: PlacementKey, overrides: Partial<AdmitInput> = {}): AdmitInput => ({
  key: k,
  commandId: "placement:" + k.placer + ":" + k.ownerKey + ":" + k.attempt + ":" + k.issuedAt,
  digest: "digest-1",
  epoch: EPOCH,
  now: T0,
  maxThreads: null,
  live: Effect.succeed(0),
  cordoned: Effect.succeed(false),
  ...overrides,
});

const admitted = (k: PlacementKey, overrides: Partial<AdmitInput> = {}) =>
  Effect.gen(function* () {
    const reservations = yield* PlacementReservations;
    const decision = yield* reservations.admit(admitInput(k, overrides));
    assert.strictEqual(decision._tag, "Admitted");
    return admitInput(k, overrides).commandId;
  });

describe("admitting a key not seen", () => {
  it.effect(
    "a key at or below the watermark is expired whatever the clock reads, and a fresh store starts at zero",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* reservations.lookup(key("fresh"))).watermark, 0);
        yield* sql`UPDATE placement_watermark SET issued_at = ${T0}`;
        for (const issuedAt of [T0, T0 - 1]) {
          const decision = yield* reservations.admit(admitInput(key("w", issuedAt)));
          assert.deepStrictEqual(decision, { _tag: "Refused", refusal: "expired" });
        }
        yield* admitted(key("above", T0 + 1));
        assert.isNull((yield* reservations.lookup(key("w", T0))).row);
      }).pipe(Effect.provide(store())),
  );

  it.effect(
    "a key more than ten minutes ahead is from the future, and one older than 25 days is expired",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const future = yield* reservations.admit(admitInput(key("f", T0 + FUTURE_MS + 1)));
        assert.deepStrictEqual(future, { _tag: "Refused", refusal: "future" });
        const old = yield* reservations.admit(admitInput(key("o", T0 - ADMIT_WINDOW_MS - 1)));
        assert.deepStrictEqual(old, { _tag: "Refused", refusal: "expired" });
        yield* admitted(key("edge-future", T0 + FUTURE_MS));
        yield* admitted(key("edge-old", T0 - ADMIT_WINDOW_MS));
      }).pipe(Effect.provide(store())),
  );

  it.effect("a cordoned target refuses a new key and keeps a pending one", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const before = yield* admitted(key("before"));
      const refused = yield* reservations.admit(
        admitInput(key("after"), { cordoned: Effect.succeed(true) }),
      );
      assert.deepStrictEqual(refused, { _tag: "Refused", refusal: "cordoned" });
      assert.strictEqual((yield* reservations.get(before))?.state, "pending");
    }).pipe(Effect.provide(store())),
  );

  it.effect(
    "pending plus live work at maxThreads is full, and a retry of the last slot joins instead",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const limits = { maxThreads: 2, live: Effect.succeed(1) };
        yield* admitted(key("first"), limits);
        const full = yield* reservations.admit(admitInput(key("second"), limits));
        assert.deepStrictEqual(full, { _tag: "Refused", refusal: "full" });
        const retry = yield* reservations.admit(admitInput(key("first"), limits));
        assert.strictEqual(retry._tag, "Known");
        assert.strictEqual(retry._tag === "Known" ? retry.reservation.state : null, "pending");
      }).pipe(Effect.provide(store())),
  );

  it.effect("with no limit set, 256 pending reservations make the target full", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      for (let index = 0; index < 256; index += 1) yield* admitted(key("p" + index));
      const full = yield* reservations.admit(admitInput(key("p256")));
      assert.deepStrictEqual(full, { _tag: "Refused", refusal: "full" });
    }).pipe(Effect.provide(store())),
  );

  it.effect("an admitted key is pending with a five minute lease under this epoch", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const commandId = yield* admitted(key("lease"));
      const row = yield* reservations.get(commandId);
      assert.strictEqual(row?.state, "pending");
      assert.strictEqual(row?.leaseUntil, T0 + LEASE_MS);
      assert.strictEqual(row?.admittedAt, T0);
      assert.strictEqual(row?.ownerEpoch, EPOCH);
    }).pipe(Effect.provide(store())),
  );
});

describe("the per-placer bound", () => {
  it.effect(
    "the 4,097th new key from one placer is refused, retries are still answered, other placers are not affected, also after a restart",
    () => {
      const file = freshFile();
      const seed = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* admitted(key("young"));
        // The rest of the bound in one statement; old rows count too until they are pruned.
        yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PLACER_BOUND - 1})
        INSERT INTO placement_reservations
          (placer, owner_key, attempt, issued_at, command_id, digest, state, owner_epoch,
           admitted_at, lease_until)
        SELECT 'pen:node-a', 'seed-' || i, 0, ${T0 - 40 * DAY}, 'seed-' || i, 'd', 'counted', 'old', 0, 0
        FROM n
      `;
      });
      const check = Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const refused = yield* reservations.admit(admitInput(key("one-more")));
        assert.deepStrictEqual(refused, { _tag: "Refused", refusal: "placer_bound" });
        const retry = yield* reservations.admit(admitInput(key("young")));
        assert.strictEqual(retry._tag, "Known");
      });
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* seed;
          yield* check;
          yield* admitted(key("other", T0, "pen:node-b"));
        }).pipe(Effect.provide(storeOn(file)));
        // A restart: the same database under a new process epoch.
        yield* check.pipe(Effect.provide(storeOn(file)));
      });
    },
  );
});

describe("a retry of a known key", () => {
  it.effect(
    "the same digest is answered from the row in every state, before capacity or cordon",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const pending = yield* admitted(key("pending"));
        const counted = yield* admitted(key("counted"));
        const fenced = yield* admitted(key("fenced"));
        assert.isTrue(
          yield* reservations.bindThread({ commandId: counted, epoch: EPOCH, threadId: "t-c" }),
        );
        assert.isTrue(
          yield* reservations.markCounted({
            commandId: counted,
            epoch: EPOCH,
            threadId: "t-c",
            runId: "r-c",
          }),
        );
        assert.isTrue(
          yield* reservations.bindThread({ commandId: fenced, epoch: EPOCH, threadId: "t-f" }),
        );
        assert.isTrue(
          yield* reservations.finalize({ commandId: fenced, epoch: EPOCH, reason: "failed" }),
        );
        const closed = { cordoned: Effect.succeed(true), maxThreads: 0 };
        const answers = yield* Effect.forEach(["pending", "counted", "fenced"], (owner) =>
          reservations.admit(admitInput(key(owner), closed)),
        );
        assert.deepStrictEqual(
          answers.map((answer) =>
            answer._tag === "Known"
              ? [answer.reservation.state, answer.reservation.threadId, answer.reservation.runId]
              : answer._tag,
          ),
          [
            ["pending", null, null],
            ["counted", "t-c", "r-c"],
            ["fenced", "t-f", null],
          ],
        );
        assert.strictEqual(pending.length > 0, true);
      }).pipe(Effect.provide(store())),
  );

  it.effect("a different digest is conflicting in every state and changes nothing", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const pending = yield* admitted(key("pending"));
      const counted = yield* admitted(key("counted"));
      yield* reservations.markCounted({
        commandId: counted,
        epoch: EPOCH,
        threadId: "t",
        runId: "r",
      });
      const fenced = yield* admitted(key("fenced"));
      yield* reservations.finalize({ commandId: fenced, epoch: EPOCH, reason: "failed" });
      for (const owner of ["pending", "counted", "fenced"]) {
        const answer = yield* reservations.admit(admitInput(key(owner), { digest: "digest-2" }));
        assert.strictEqual(answer._tag, "Conflicting");
      }
      assert.strictEqual((yield* reservations.get(pending))?.state, "pending");
      assert.strictEqual((yield* reservations.get(pending))?.digest, "digest-1");
    }).pipe(Effect.provide(store())),
  );
});

describe("guarded commits", () => {
  it.effect("bindThread and markCounted write only a pending row of this epoch", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const live = yield* admitted(key("live"));
      const fenced = yield* admitted(key("fenced"));
      yield* reservations.finalize({ commandId: fenced, epoch: EPOCH, reason: "lease lapsed" });
      const bind = (commandId: string, epoch = EPOCH) =>
        reservations.bindThread({ commandId, epoch, threadId: "t" });
      assert.isFalse(yield* bind("absent"));
      assert.isFalse(yield* bind(fenced));
      assert.isFalse(yield* bind(live, "epoch-b"));
      assert.isTrue(yield* bind(live));
      const count = (commandId: string, epoch = EPOCH) =>
        reservations.markCounted({ commandId, epoch, threadId: "t", runId: "r" });
      assert.isFalse(yield* count("absent"));
      assert.isFalse(yield* count(fenced));
      assert.isFalse(yield* count(live, "epoch-b"));
      assert.isTrue(yield* count(live));
      assert.isFalse(yield* count(live));
      const row = yield* reservations.get(live);
      assert.deepStrictEqual([row?.state, row?.threadId, row?.runId], ["counted", "t", "r"]);
      assert.strictEqual((yield* reservations.get(fenced))?.state, "fenced");
    }).pipe(Effect.provide(store())),
  );
});

describe("lease, sweep, finalizer and restart", () => {
  it.effect(
    "a renewal extends only a pending row of this epoch and never revives a fenced one",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const live = yield* admitted(key("live"));
        const counted = yield* admitted(key("counted"));
        yield* reservations.markCounted({
          commandId: counted,
          epoch: EPOCH,
          threadId: "t",
          runId: "r",
        });
        const fenced = yield* admitted(key("fenced"));
        yield* reservations.finalize({ commandId: fenced, epoch: EPOCH, reason: "failed" });
        const later = T0 + 60_000;
        const renew = (commandId: string, epoch = EPOCH) =>
          reservations.renew({ commandId, epoch, now: later });
        assert.isTrue(yield* renew(live));
        assert.strictEqual((yield* reservations.get(live))?.leaseUntil, later + LEASE_MS);
        assert.isFalse(yield* renew(live, "epoch-b"));
        assert.isFalse(yield* renew(counted));
        assert.isFalse(yield* renew(fenced));
        assert.isFalse(yield* renew("absent"));
        assert.strictEqual((yield* reservations.get(fenced))?.state, "fenced");
        assert.strictEqual((yield* reservations.get(counted))?.leaseUntil, T0 + LEASE_MS);
      }).pipe(Effect.provide(store())),
  );

  it.effect(
    "the sweep fences a lapsed lease, leaves a renewed one pending, and fences anything pending past 60 minutes",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const lapsed = yield* admitted(key("lapsed"));
        const renewed = yield* admitted(key("renewed"));
        const counted = yield* admitted(key("counted"));
        yield* reservations.markCounted({
          commandId: counted,
          epoch: EPOCH,
          threadId: "t",
          runId: "r",
        });
        const at = T0 + LEASE_MS + 1;
        yield* reservations.renew({ commandId: renewed, epoch: EPOCH, now: at - 2 });
        yield* reservations.sweep(at);
        assert.deepStrictEqual(
          [(yield* reservations.get(lapsed))?.state, (yield* reservations.get(lapsed))?.reason],
          ["fenced", "lease lapsed"],
        );
        assert.strictEqual((yield* reservations.get(renewed))?.state, "pending");
        assert.strictEqual((yield* reservations.get(counted))?.state, "counted");
        // Renewed every minute for an hour: the cap still fences it.
        const capAt = T0 + PENDING_CAP_MS + 1;
        yield* reservations.renew({ commandId: renewed, epoch: EPOCH, now: capAt - 1 });
        yield* reservations.sweep(capAt);
        assert.deepStrictEqual(
          [(yield* reservations.get(renewed))?.state, (yield* reservations.get(renewed))?.reason],
          ["fenced", "launch took longer than 60 minutes"],
        );
      }).pipe(Effect.provide(store())),
  );

  it.effect("the finalizer fences only a pending row; a counted row stays counted", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const pending = yield* admitted(key("pending"));
      const counted = yield* admitted(key("counted"));
      yield* reservations.markCounted({
        commandId: counted,
        epoch: EPOCH,
        threadId: "t",
        runId: "r",
      });
      assert.isTrue(
        yield* reservations.finalize({ commandId: pending, epoch: EPOCH, reason: "boom" }),
      );
      assert.isFalse(
        yield* reservations.finalize({ commandId: counted, epoch: EPOCH, reason: "boom" }),
      );
      assert.strictEqual((yield* reservations.get(counted))?.state, "counted");
      assert.strictEqual((yield* reservations.get(pending))?.reason, "boom");
    }).pipe(Effect.provide(store())),
  );

  it.effect("a restart fences pending rows of another epoch, keeping their thread ids", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const old = yield* admitted(key("old"), { epoch: "epoch-old" });
      yield* reservations.bindThread({ commandId: old, epoch: "epoch-old", threadId: "t-old" });
      const mine = yield* admitted(key("mine"));
      assert.strictEqual(yield* reservations.fenceStale(EPOCH), 1);
      const row = yield* reservations.get(old);
      assert.deepStrictEqual(
        [row?.state, row?.reason, row?.threadId],
        ["fenced", "restarted", "t-old"],
      );
      assert.strictEqual((yield* reservations.get(mine))?.state, "pending");
    }).pipe(Effect.provide(store())),
  );
});

describe("prune and the watermark", () => {
  it.effect(
    "prune deletes terminal rows older than 30 days and raises the watermark in the same transaction; pending rows stay",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const sql = yield* SqlClient.SqlClient;
        const counted = yield* admitted(key("counted", T0));
        yield* reservations.markCounted({
          commandId: counted,
          epoch: EPOCH,
          threadId: "t",
          runId: "r",
        });
        const fenced = yield* admitted(key("fenced", T0 + 5));
        yield* reservations.finalize({ commandId: fenced, epoch: EPOCH, reason: "failed" });
        const stuck = yield* admitted(key("stuck", T0 + 5));
        const young = yield* admitted(key("young", T0 + 10 * DAY), { now: T0 + 10 * DAY });
        yield* reservations.finalize({ commandId: young, epoch: EPOCH, reason: "failed" });
        const result = yield* reservations.prune(T0 + 5 + RETAIN_MS + 1);
        assert.deepStrictEqual(result, { deleted: 2, watermark: T0 + 5 });
        assert.isNull(yield* reservations.get(counted));
        assert.isNull(yield* reservations.get(fenced));
        assert.strictEqual((yield* reservations.get(stuck))?.state, "pending");
        assert.strictEqual((yield* reservations.get(young))?.state, "fenced");
        // Equal timestamps: the remaining row answers, the pruned key reads expired.
        const remaining = yield* reservations.admit(
          admitInput(key("stuck", T0 + 5), { now: T0 + 1 }),
        );
        assert.strictEqual(remaining._tag, "Known");
        const pruned = yield* reservations.admit(
          admitInput(key("fenced", T0 + 5), { now: T0 + 1 }),
        );
        assert.deepStrictEqual(pruned, { _tag: "Refused", refusal: "expired" });
        // Nothing older to delete: the watermark never moves back.
        yield* sql`UPDATE placement_watermark SET issued_at = ${T0 + 100}`;
        const again = yield* reservations.prune(T0 + 5 + RETAIN_MS + 2);
        assert.deepStrictEqual(again, { deleted: 0, watermark: T0 + 100 });
      }).pipe(Effect.provide(store())),
  );

  it.effect("a missing watermark fails closed and is never re-created", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM placement_watermark`;
      const failed = yield* reservations.admit(admitInput(key("any"))).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "PlacementStoreError");
      const pruneFailed = yield* reservations.prune(T0).pipe(Effect.flip);
      assert.strictEqual(pruneFailed._tag, "PlacementStoreError");
      assert.deepStrictEqual(yield* sql`SELECT * FROM placement_watermark`, []);
    }).pipe(Effect.provide(store())),
  );
});

describe("atomicity in the real store", () => {
  it.effect(
    "a prune whose watermark write fails deletes nothing and leaves the watermark as it was",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const sql = yield* SqlClient.SqlClient;
        const commandId = yield* admitted(key("old"));
        yield* reservations.finalize({ commandId, epoch: EPOCH, reason: "failed" });
        yield* sql`
        CREATE TRIGGER fail_watermark BEFORE UPDATE ON placement_watermark
        BEGIN SELECT RAISE(ABORT, 'injected watermark failure'); END
      `;
        const failed = yield* reservations.prune(T0 + RETAIN_MS + 1).pipe(Effect.flip);
        assert.strictEqual(failed._tag, "PlacementStoreError");
        assert.strictEqual((yield* reservations.get(commandId))?.state, "fenced");
        assert.strictEqual((yield* reservations.lookup(key("old"))).watermark, 0);
        yield* sql`DROP TRIGGER fail_watermark`;
        assert.deepStrictEqual(yield* reservations.prune(T0 + RETAIN_MS + 1), {
          deleted: 1,
          watermark: T0,
        });
      }).pipe(Effect.provide(store())),
  );

  it.effect(
    "a renewal racing the sweep at the lease boundary leaves the row pending exactly when the renewal wrote",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        for (let round = 0; round < 12; round += 1) {
          const commandId = yield* admitted(key("race-" + round));
          const boundary = T0 + LEASE_MS + 1;
          const [renewed] = yield* Effect.all(
            [
              reservations.renew({ commandId, epoch: EPOCH, now: boundary - 1 }),
              reservations.sweep(boundary),
            ],
            { concurrency: "unbounded" },
          );
          const row = yield* reservations.get(commandId);
          assert.strictEqual(row?.state === "pending", renewed);
          assert.strictEqual(row?.state === "fenced", !renewed);
        }
      }).pipe(Effect.provide(store())),
  );
});

describe("clock jumps", () => {
  it.effect(
    "after a prune at day 31, a clock moved back to day 26 and then into the window still reads the pruned key expired, also after a restart",
    () => {
      const file = freshFile();
      const k = key("jumped", T0);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const reservations = yield* PlacementReservations;
          const commandId = yield* admitted(k);
          yield* reservations.markCounted({ commandId, epoch: EPOCH, threadId: "t", runId: "r" });
          assert.strictEqual((yield* reservations.prune(T0 + 31 * DAY)).deleted, 1);
          for (const now of [T0 + 26 * DAY, T0 + 1]) {
            const answer = yield* reservations.admit(admitInput(k, { now }));
            assert.deepStrictEqual(answer, { _tag: "Refused", refusal: "expired" });
          }
        }).pipe(Effect.provide(storeOn(file)));
        yield* Effect.gen(function* () {
          const reservations = yield* PlacementReservations;
          const answer = yield* reservations.admit(
            admitInput(k, { now: T0 + 1, epoch: "epoch-b" }),
          );
          assert.deepStrictEqual(answer, { _tag: "Refused", refusal: "expired" });
        }).pipe(Effect.provide(storeOn(file)));
      });
    },
  );

  it.effect(
    "a clock far ahead refuses new keys as expired, fences pending launches, prunes early and keeps those keys expired",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        const pending = yield* admitted(key("pending"));
        const counted = yield* admitted(key("counted", T0 + 1));
        yield* reservations.markCounted({
          commandId: counted,
          epoch: EPOCH,
          threadId: "t",
          runId: "r",
        });
        const ahead = T0 + 40 * DAY;
        const fresh = yield* reservations.admit(admitInput(key("new", T0 + 2), { now: ahead }));
        assert.deepStrictEqual(fresh, { _tag: "Refused", refusal: "expired" });
        yield* reservations.sweep(ahead);
        assert.strictEqual((yield* reservations.get(pending))?.state, "fenced");
        const pruned = yield* reservations.prune(ahead);
        assert.strictEqual(pruned.watermark, T0 + 1);
        const retry = yield* reservations.admit(
          admitInput(key("counted", T0 + 1), { now: T0 + 2 }),
        );
        assert.deepStrictEqual(retry, { _tag: "Refused", refusal: "expired" });
      }).pipe(Effect.provide(store())),
  );

  it.effect("a clock far behind refuses keys from the future and prunes nothing", () =>
    Effect.gen(function* () {
      const reservations = yield* PlacementReservations;
      const counted = yield* admitted(key("counted"));
      yield* reservations.markCounted({
        commandId: counted,
        epoch: EPOCH,
        threadId: "t",
        runId: "r",
      });
      const behind = T0 - 30 * DAY;
      const answer = yield* reservations.admit(admitInput(key("new", T0), { now: behind }));
      assert.deepStrictEqual(answer, { _tag: "Refused", refusal: "future" });
      assert.deepStrictEqual(yield* reservations.prune(behind), { deleted: 0, watermark: 0 });
      assert.strictEqual((yield* reservations.get(counted))?.state, "counted");
    }).pipe(Effect.provide(store())),
  );

  it.effect(
    "a prune racing a retry of the same key gives the row's answer or expired, never a new admission",
    () =>
      Effect.gen(function* () {
        const reservations = yield* PlacementReservations;
        for (let round = 0; round < 20; round += 1) {
          const k = key("race-" + round, T0 + round);
          const commandId = yield* admitted(k);
          yield* reservations.finalize({ commandId, epoch: EPOCH, reason: "failed" });
          const [, answer] = yield* Effect.all(
            [
              reservations.prune(T0 + round + RETAIN_MS + 1),
              reservations.admit(admitInput(k, { now: T0 + round })),
            ],
            { concurrency: "unbounded" },
          );
          assert.notStrictEqual(answer._tag, "Admitted");
          assert.isTrue(
            answer._tag === "Known" || (answer._tag === "Refused" && answer.refusal === "expired"),
          );
        }
      }).pipe(Effect.provide(store())),
  );
});
