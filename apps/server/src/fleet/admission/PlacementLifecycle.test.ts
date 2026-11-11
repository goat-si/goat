// @effect-diagnostics nodeBuiltinImport:off - each cell gets a scratch database folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
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
  type PlacementStoreError,
  layer as reservationsLayer,
} from "./PlacementReservations.ts";

// The section 11 lifecycle table of the mesh link design, one test per cell that can happen, against
// the real store on a file database. Columns are the key's state before the event.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const EPOCH = "epoch-a";
const K: PlacementKey = { placer: "pen:node-a", ownerKey: "goal:g:a1", attempt: 0, issuedAt: T0 };
const COMMAND = "placement:cell";

type State = "absent" | "pending" | "counted" | "fenced" | "pruned";
type Failure = PlacementStoreError | SqlError.SqlError;

const input = (overrides: Partial<AdmitInput> = {}): AdmitInput => ({
  key: K,
  commandId: COMMAND,
  digest: "digest-1",
  epoch: EPOCH,
  now: T0,
  maxThreads: null,
  live: Effect.succeed(0),
  cordoned: Effect.succeed(false),
  ...overrides,
});

const owned = { commandId: COMMAND, epoch: EPOCH };

/** Puts the key in the column's state; a created thread is bound wherever the state allows one. */
const into = (state: State) =>
  Effect.gen(function* () {
    const store = yield* PlacementReservations;
    if (state === "absent") return;
    const admitted = yield* store.admit(input());
    assert.strictEqual(admitted._tag, "Admitted");
    if (state === "pending") return;
    assert.isTrue(yield* store.bindThread({ ...owned, threadId: "t" }));
    if (state === "fenced") {
      assert.isTrue(yield* store.finalize({ ...owned, reason: "failed" }));
      return;
    }
    assert.isTrue(yield* store.markCounted({ ...owned, threadId: "t", runId: "r" }));
    if (state === "pruned") assert.strictEqual((yield* store.prune(T0 + RETAIN_MS + 1)).deleted, 1);
  });

/** The key's row (state, reason, thread, run, lease) and the watermark. */
const observe = Effect.gen(function* () {
  const { row, watermark } = yield* Effect.flatMap(PlacementReservations, (store) =>
    store.lookup(K),
  );
  return {
    row:
      row === null
        ? null
        : {
            state: row.state,
            reason: row.reason,
            threadId: row.threadId,
            runId: row.runId,
            digest: row.digest,
          },
    watermark,
  };
});

const COUNTED = { state: "counted", reason: null, threadId: "t", runId: "r", digest: "digest-1" };
const FENCED = {
  state: "fenced",
  reason: "failed",
  threadId: "t",
  runId: null,
  digest: "digest-1",
};
const PENDING = { state: "pending", reason: null, threadId: null, runId: null, digest: "digest-1" };
const GONE = { row: null, watermark: T0 };
const NONE = { row: null, watermark: 0 };
const unchanged = (state: State) =>
  ({
    absent: NONE,
    pending: { row: PENDING, watermark: 0 },
    counted: { row: COUNTED, watermark: 0 },
    fenced: { row: FENCED, watermark: 0 },
    pruned: GONE,
  })[state];

const store = () => PlacementReservations;
const admit = (overrides: Partial<AdmitInput> = {}) =>
  Effect.flatMap(store(), (s) => s.admit(input(overrides)));
const tag = (decision: { readonly _tag: string; readonly refusal?: string }) =>
  decision._tag === "Refused" ? "Refused:" + decision.refusal : decision._tag;

interface Cell {
  readonly event: string;
  readonly state: State;
  readonly expect: string;
  readonly run: Effect.Effect<void, Failure, PlacementReservations | SqlClient.SqlClient>;
}

const cell = (event: string, state: State, expect: string, run: Cell["run"]): Cell => ({
  event,
  state,
  expect,
  run,
});

/** The answer, then the row and watermark afterwards. */
const answers = (
  decision: Effect.Effect<
    { readonly _tag: string; readonly refusal?: string },
    Failure,
    PlacementReservations
  >,
  expected: string,
  after: unknown,
) =>
  Effect.gen(function* () {
    assert.strictEqual(tag(yield* decision), expected);
    assert.deepStrictEqual(yield* observe, after);
  });

const writes = (
  write: Effect.Effect<boolean | number, Failure, PlacementReservations>,
  expected: boolean | number,
  after: unknown,
) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* write, expected);
    assert.deepStrictEqual(yield* observe, after);
  });

const sweepAt = (now: number) => Effect.flatMap(store(), (s) => s.sweep(now));
const pruneAt = (now: number) =>
  Effect.flatMap(store(), (s) => Effect.map(s.prune(now), (result) => result.deleted));
const renewAt = (now: number) => Effect.flatMap(store(), (s) => s.renew({ ...owned, now }));

const fillPlacer = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PLACER_BOUND})
    INSERT INTO placement_reservations
      (placer, owner_key, attempt, issued_at, command_id, digest, state, owner_epoch, admitted_at, lease_until)
    SELECT 'pen:node-a', 'other:' || i, 0, ${T0}, 'other:' || i, 'd', 'counted', 'epoch-a', ${T0}, ${T0} FROM n
  `;
});

const ADMITTED = { row: PENDING, watermark: 0 };
const PRUNED_ANSWER = "Refused:expired";

const cells: ReadonlyArray<Cell> = [
  // Admit, key not seen.
  cell("admit", "absent", "admitted pending", answers(admit(), "Admitted", ADMITTED)),
  cell(
    "admit",
    "absent",
    "issuedAt at or below the watermark is expired whatever the clock reads",
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE placement_watermark SET issued_at = ${T0}`;
      yield* answers(admit(), "Refused:expired", { row: null, watermark: T0 });
    }),
  ),
  cell(
    "admit",
    "absent",
    "more than 10 minutes ahead is a key from the future",
    answers(admit({ now: T0 - FUTURE_MS - 1 }), "Refused:future", NONE),
  ),
  cell(
    "admit",
    "absent",
    "more than 25 days old is expired",
    answers(admit({ now: T0 + ADMIT_WINDOW_MS + 1 }), "Refused:expired", NONE),
  ),
  cell(
    "admit",
    "absent",
    "a placer at its bound is refused",
    Effect.andThen(fillPlacer, answers(admit(), "Refused:placer_bound", NONE)),
  ),
  cell(
    "admit",
    "absent",
    "cordoned",
    answers(admit({ cordoned: Effect.succeed(true) }), "Refused:cordoned", NONE),
  ),
  cell(
    "admit",
    "absent",
    "full",
    answers(admit({ maxThreads: 1, live: Effect.succeed(1) }), "Refused:full", NONE),
  ),
  cell(
    "admit",
    "pruned",
    "expired by the watermark, also with the clock back inside the window",
    Effect.gen(function* () {
      yield* answers(admit({ now: T0 + 1 }), PRUNED_ANSWER, GONE);
      yield* answers(admit({ now: T0 + RETAIN_MS + 2 }), PRUNED_ANSWER, GONE);
    }),
  ),

  // Retry, same key and digest.
  cell("retry", "absent", "the admit row", answers(admit(), "Admitted", ADMITTED)),
  cell(
    "retry",
    "pending",
    "joined, still pending",
    answers(admit(), "Known", unchanged("pending")),
  ),
  cell(
    "retry",
    "counted",
    "started with thread and run ids",
    answers(admit(), "Known", unchanged("counted")),
  ),
  cell(
    "retry",
    "fenced",
    "not started, with its thread id",
    answers(admit(), "Known", unchanged("fenced")),
  ),
  cell("retry", "pruned", "expired", answers(admit({ now: T0 + 1 }), PRUNED_ANSWER, GONE)),

  // Retry, same key, different digest.
  cell(
    "retry with another digest",
    "absent",
    "the admit row, and this request is the one of record",
    answers(admit({ digest: "digest-2" }), "Admitted", {
      row: { ...PENDING, digest: "digest-2" },
      watermark: 0,
    }),
  ),
  ...(["pending", "counted", "fenced"] as const).map((state) =>
    cell(
      "retry with another digest",
      state,
      "conflicting, unchanged",
      answers(admit({ digest: "digest-2" }), "Conflicting", unchanged(state)),
    ),
  ),
  cell(
    "retry with another digest",
    "pruned",
    "expired",
    answers(admit({ digest: "digest-2", now: T0 + 1 }), PRUNED_ANSWER, GONE),
  ),

  // thread.create commit: the guard's write.
  cell(
    "thread.create guard",
    "absent",
    "finds no row and refuses",
    writes(
      Effect.flatMap(store(), (s) => s.bindThread({ ...owned, threadId: "t" })),
      false,
      NONE,
    ),
  ),
  cell(
    "thread.create guard",
    "pending",
    "binds the thread under this epoch and stays pending; another epoch is refused",
    Effect.gen(function* () {
      const s = yield* store();
      assert.isFalse(yield* s.bindThread({ ...owned, epoch: "epoch-old", threadId: "x" }));
      yield* writes(s.bindThread({ ...owned, threadId: "t" }), true, {
        row: { ...PENDING, threadId: "t" },
        watermark: 0,
      });
    }),
  ),
  cell(
    "thread.create guard",
    "fenced",
    "refuses",
    writes(
      Effect.flatMap(store(), (s) => s.bindThread({ ...owned, threadId: "t2" })),
      false,
      unchanged("fenced"),
    ),
  ),

  // Initial message.dispatch commit: the guard's write.
  cell(
    "message guard",
    "absent",
    "refuses",
    writes(
      Effect.flatMap(store(), (s) => s.markCounted({ ...owned, threadId: "t", runId: "r" })),
      false,
      NONE,
    ),
  ),
  cell(
    "message guard",
    "pending",
    "counted with thread and run ids in the same write",
    writes(
      Effect.flatMap(store(), (s) => s.markCounted({ ...owned, threadId: "t", runId: "r" })),
      true,
      unchanged("counted"),
    ),
  ),
  cell(
    "message guard",
    "counted",
    "a second write changes nothing (a replay never reaches the guard)",
    writes(
      Effect.flatMap(store(), (s) => s.markCounted({ ...owned, threadId: "t9", runId: "r9" })),
      false,
      unchanged("counted"),
    ),
  ),
  cell(
    "message guard",
    "fenced",
    "refuses; the created thread stays idle",
    writes(
      Effect.flatMap(store(), (s) => s.markCounted({ ...owned, threadId: "t", runId: "r" })),
      false,
      unchanged("fenced"),
    ),
  ),

  // Lease renewal by the owner.
  cell("renewal", "absent", "writes nothing", writes(renewAt(T0 + 1000), false, NONE)),
  cell(
    "renewal",
    "pending",
    "extends the lease by five minutes",
    Effect.gen(function* () {
      assert.isTrue(yield* renewAt(T0 + 4 * 60_000));
      // Renewed: a sweep at the old expiry leaves it pending.
      assert.strictEqual(yield* sweepAt(T0 + LEASE_MS + 1), 0);
      assert.deepStrictEqual<unknown>(yield* observe, unchanged("pending"));
    }),
  ),
  ...(["counted", "fenced", "pruned"] as const).map((state) =>
    cell(
      "renewal",
      state,
      "writes nothing and revives nothing",
      writes(renewAt(T0 + 1000), false, unchanged(state)),
    ),
  ),

  // Lease expiry found by the sweep.
  ...(["absent", "counted", "fenced", "pruned"] as const).map((state) =>
    cell(
      "lease expiry",
      state,
      "no change",
      writes(sweepAt(T0 + LEASE_MS + 1), 0, unchanged(state)),
    ),
  ),
  cell(
    "lease expiry",
    "pending",
    "a lapsed lease is fenced",
    writes(sweepAt(T0 + LEASE_MS + 1), 1, {
      row: { ...PENDING, state: "fenced", reason: "lease lapsed" },
      watermark: 0,
    }),
  ),

  // The 60-minute cap.
  ...(["absent", "counted", "fenced", "pruned"] as const).map((state) =>
    cell(
      "60-minute cap",
      state,
      "no change",
      writes(sweepAt(T0 + PENDING_CAP_MS + 1), 0, unchanged(state)),
    ),
  ),
  cell(
    "60-minute cap",
    "pending",
    "fences a row that kept renewing",
    Effect.gen(function* () {
      assert.isTrue(yield* renewAt(T0 + PENDING_CAP_MS - 1000));
      yield* writes(sweepAt(T0 + PENDING_CAP_MS + 1), 1, {
        row: { ...PENDING, state: "fenced", reason: "launch took longer than 60 minutes" },
        watermark: 0,
      });
    }),
  ),

  // A failure returned to the owner's finalizer.
  cell(
    "returned failure",
    "pending",
    "fenced with the reason",
    writes(
      Effect.flatMap(store(), (s) => s.finalize({ ...owned, reason: "boom" })),
      true,
      { row: { ...PENDING, state: "fenced", reason: "boom" }, watermark: 0 },
    ),
  ),
  cell(
    "returned failure",
    "counted",
    "stays counted: the outcome follows the row, not the exception",
    writes(
      Effect.flatMap(store(), (s) => s.finalize({ ...owned, reason: "boom" })),
      false,
      unchanged("counted"),
    ),
  ),
  cell(
    "returned failure",
    "fenced",
    "no change",
    writes(
      Effect.flatMap(store(), (s) => s.finalize({ ...owned, reason: "boom" })),
      false,
      unchanged("fenced"),
    ),
  ),

  // Crash and restart: the new epoch fences pending rows before admission opens.
  ...(["absent", "counted", "fenced", "pruned"] as const).map((state) =>
    cell(
      "restart",
      state,
      "no change",
      writes(
        Effect.flatMap(store(), (s) => s.fenceStale("epoch-b")),
        0,
        unchanged(state),
      ),
    ),
  ),
  cell(
    "restart",
    "pending",
    "fenced as restarted, keeping the created thread",
    Effect.gen(function* () {
      const s = yield* store();
      assert.isTrue(yield* s.bindThread({ ...owned, threadId: "t" }));
      yield* writes(s.fenceStale("epoch-b"), 1, {
        row: { ...PENDING, state: "fenced", reason: "restarted", threadId: "t" },
        watermark: 0,
      });
    }),
  ),

  // Cordon set.
  cell(
    "cordon",
    "absent",
    "later admits are refused",
    answers(admit({ cordoned: Effect.succeed(true) }), "Refused:cordoned", NONE),
  ),
  cell(
    "cordon",
    "pending",
    "continues: a retry joins and the owner's commit still counts it",
    Effect.gen(function* () {
      yield* answers(admit({ cordoned: Effect.succeed(true) }), "Known", unchanged("pending"));
      yield* writes(
        Effect.flatMap(store(), (s) => s.markCounted({ ...owned, threadId: "t", runId: "r" })),
        true,
        unchanged("counted"),
      );
    }),
  ),
  ...(["counted", "fenced"] as const).map((state) =>
    cell(
      "cordon",
      state,
      "a retry still gets its outcome",
      answers(admit({ cordoned: Effect.succeed(true) }), "Known", unchanged(state)),
    ),
  ),
  cell(
    "cordon",
    "pruned",
    "still expired",
    answers(admit({ cordoned: Effect.succeed(true), now: T0 + 1 }), PRUNED_ANSWER, GONE),
  ),

  // Daily prune, 30 days by the target's clock.
  cell("prune", "absent", "no change", writes(pruneAt(T0 + RETAIN_MS + 1), 0, NONE)),
  cell(
    "prune",
    "pending",
    "never pruned",
    writes(pruneAt(T0 + RETAIN_MS + 1), 0, unchanged("pending")),
  ),
  ...(["counted", "fenced"] as const).map((state) =>
    cell(
      "prune",
      state,
      "deleted, the watermark raised to its issuedAt, later retries expired",
      Effect.gen(function* () {
        assert.strictEqual(yield* pruneAt(T0 + RETAIN_MS - 1), 0);
        yield* writes(pruneAt(T0 + RETAIN_MS + 1), 1, GONE);
        yield* answers(admit({ now: T0 + 1 }), PRUNED_ANSWER, GONE);
      }),
    ),
  ),
  cell("prune", "pruned", "no change", writes(pruneAt(T0 + RETAIN_MS + 2), 0, GONE)),

  // The target's clock jumps far ahead.
  cell(
    "clock far ahead",
    "absent",
    "new keys read expired",
    answers(admit({ now: T0 + 40 * DAY }), "Refused:expired", NONE),
  ),
  cell(
    "clock far ahead",
    "pending",
    "the sweep fences it, never leaving it uncounted",
    writes(sweepAt(T0 + 40 * DAY), 1, {
      row: { ...PENDING, state: "fenced", reason: "lease lapsed" },
      watermark: 0,
    }),
  ),
  ...(["counted", "fenced"] as const).map((state) =>
    cell(
      "clock far ahead",
      state,
      "may be pruned early; the watermark keeps it expired",
      Effect.gen(function* () {
        yield* writes(pruneAt(T0 + 40 * DAY), 1, GONE);
        yield* answers(admit({ now: T0 + 1 }), PRUNED_ANSWER, GONE);
      }),
    ),
  ),
  cell(
    "clock far ahead",
    "pruned",
    "stays expired",
    answers(admit({ now: T0 + 40 * DAY }), PRUNED_ANSWER, GONE),
  ),

  // The target's clock jumps far behind.
  cell(
    "clock far behind",
    "absent",
    "keys read from the future",
    answers(admit({ now: T0 - DAY }), "Refused:future", NONE),
  ),
  cell(
    "clock far behind",
    "pending",
    "the lease lasts longer by the clock and the row keeps its slot",
    writes(sweepAt(T0 - DAY), 0, unchanged("pending")),
  ),
  ...(["counted", "fenced"] as const).map((state) =>
    cell(
      "clock far behind",
      state,
      "nothing is pruned",
      writes(pruneAt(T0 - DAY), 0, unchanged(state)),
    ),
  ),
  cell(
    "clock far behind",
    "pruned",
    "still expired: the watermark never moves back",
    Effect.gen(function* () {
      assert.strictEqual(yield* pruneAt(T0 - DAY), 0);
      yield* answers(admit({ now: T0 - DAY + FUTURE_MS }), PRUNED_ANSWER, GONE);
    }),
  ),
];

describe("the section 11 lifecycle table, one test per cell that can happen", () => {
  it.effect.each(cells)("$event x $state: $expect", (entry) =>
    Effect.gen(function* () {
      yield* into(entry.state);
      yield* entry.run;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          reservationsLayer,
          SqlitePersistence.layerFromPath(
            NodePath.join(
              NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placement-cell-")),
              "state.sqlite",
            ),
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  );
});
