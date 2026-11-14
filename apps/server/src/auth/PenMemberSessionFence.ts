import { PenId, type AuthSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { UnknownSessionTokenError } from "./sessionStoreErrors.ts";

const isPenId = Schema.is(PenId);

type Row = {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly penMemberNode: string | null;
};

export const make = Effect.fn("PenMemberSessionFence.make")(function* (
  initial: ReadonlyArray<Row>,
  suspend: (id: AuthSessionId) => Effect.Effect<void>,
  resume: (id: AuthSessionId) => Effect.Effect<void>,
) {
  const lock = yield* Semaphore.make(1);
  const relevant = (row: Row) =>
    row.penMemberNode !== null || row.subject.startsWith("pen-member:");
  const rows = new Map(initial.filter(relevant).map((row) => [row.sessionId, row]));
  let admitted: ReadonlySet<string> | "closed" = "closed";
  const isDenied = (row: Row) =>
    row.penMemberNode === null
      ? row.subject.startsWith("pen-member:")
      : !isPenId(row.penMemberNode) ||
        row.subject !== `pen-member:${row.penMemberNode}` ||
        admitted === "closed" ||
        !admitted.has(row.penMemberNode);
  const denied = (id: AuthSessionId) =>
    Effect.sync(() => {
      const row = rows.get(id);
      return row === undefined ? false : isDenied(row);
    });
  const observe = Effect.fn("PenMemberSessionFence.observe")((row: Row) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!relevant(row)) {
          rows.delete(row.sessionId);
          return;
        }
        rows.set(row.sessionId, row);
        if (isDenied(row)) yield* suspend(row.sessionId);
      }),
    ),
  );
  const guardId = Effect.fn("PenMemberSessionFence.guardId")(function* (id: AuthSessionId) {
    if (yield* denied(id)) return yield* new UnknownSessionTokenError({ sessionId: id });
  });
  const guard = Effect.fn("PenMemberSessionFence.guard")(function* (row: Row) {
    yield* observe(row);
    yield* guardId(row.sessionId);
  });
  const setAdmitted = Effect.fn("PenMemberSessionFence.setAdmitted")(
    (view: ReadonlySet<string> | "closed") =>
      lock.withPermit(
        Effect.gen(function* () {
          const previous = new Map(Array.from(rows, ([id, row]) => [id, isDenied(row)]));
          admitted = view === "closed" ? view : new Set(view);
          for (const [id, row] of rows) {
            const next = isDenied(row);
            if (next && !previous.get(id)) yield* suspend(id);
            if (!next && previous.get(id)) yield* resume(id);
          }
        }),
      ),
  );
  const forget = (id: AuthSessionId) =>
    lock.withPermit(
      Effect.sync(() => {
        rows.delete(id);
      }),
    );
  return { observe, guard, guardId, denied, setAdmitted, forget };
});
