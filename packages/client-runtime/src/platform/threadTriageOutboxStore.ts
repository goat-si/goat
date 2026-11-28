import { CommandId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const PendingThreadTriageAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("settle") }),
  Schema.Struct({ type: Schema.Literal("snooze"), snoozedUntil: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("unsettle"),
    reason: Schema.Literals(["user", "automatic"]),
  }),
  Schema.Struct({ type: Schema.Literal("unsnooze") }),
]);

const PendingThreadTriageFields = {
  environmentId: EnvironmentId,
  threadId: ThreadId,
  commandId: CommandId,
  action: PendingThreadTriageAction,
  queuedAt: Schema.DateTimeUtcFromString,
  /** The thread as the user saw it; if it shows otherwise on reconnect, the change is dropped. */
  seen: Schema.String,
  /** Set before replay sends over the wire so offline undo knows the server may have committed it. */
  attempted: Schema.optionalKey(Schema.Literal(true)),
  /** Set when queued behind a compensating undo whose replay mutates server triage timestamps. */
  afterCompensation: Schema.optionalKey(Schema.Literal(true)),
};

const DisplacedPendingThreadTriage = Schema.Struct(PendingThreadTriageFields);
export type DisplacedPendingThreadTriage = typeof DisplacedPendingThreadTriage.Type;

export const PendingThreadTriage = Schema.Struct({
  ...PendingThreadTriageFields,
  /** Displaced entries persisted with a write-ahead replacement so definitive rejection restores them in order. */
  displaced: Schema.optionalKey(Schema.Array(DisplacedPendingThreadTriage)),
});
export type PendingThreadTriage = typeof PendingThreadTriage.Type;
export type PendingThreadTriages = ReadonlyArray<PendingThreadTriage>;

const Stored = Schema.fromJsonString(Schema.Struct({ entries: Schema.Array(PendingThreadTriage) }));
const decodeStored = Schema.decodeUnknownExit(Stored);
const encodeStored = Schema.encodeSync(Stored);

export class ThreadTriageOutboxStorageError extends Schema.TaggedError<ThreadTriageOutboxStorageError>()(
  "ThreadTriageOutboxStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not save the change for later sync.";
  }
}

/**
 * Settle and snooze taken while an environment is offline, kept apart from the environment
 * cache so clearing the cache does not drop them. Removing the environment does.
 */
export interface ThreadTriageOutboxStoreShape {
  /** Stores `change(stored)` in one step and returns it. Returning `stored` itself only reads. */
  readonly update: (
    change: (stored: PendingThreadTriages) => PendingThreadTriages,
  ) => Effect.Effect<PendingThreadTriages, ThreadTriageOutboxStorageError>;
  readonly clearEnvironment: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>;
}

/**
 * `modify` replaces the stored text with `next(stored)`, or keeps it when that is null. Text that
 * no longer decodes reads as empty.
 */
export function makeThreadTriageOutboxStore(
  modify: (
    next: (stored: string | null) => string | null,
  ) => Effect.Effect<void, ThreadTriageOutboxStorageError>,
): ThreadTriageOutboxStoreShape {
  // Platforms whose `modify` reads and writes in separate steps rely on this to not interleave.
  const lock = Semaphore.makeUnsafe(1);
  const update: ThreadTriageOutboxStoreShape["update"] = (change) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        let result: PendingThreadTriages = [];
        return modify((raw) => {
          const decoded = raw === null ? undefined : decodeStored(raw);
          const stored =
            decoded !== undefined && Exit.isSuccess(decoded) ? decoded.value.entries : [];
          result = change(stored);
          return result === stored ? null : encodeStored({ entries: result });
        }).pipe(Effect.map(() => result));
      }),
    );
  return {
    update,
    clearEnvironment: (environmentId) =>
      update((stored) =>
        stored.some((entry) => entry.environmentId === environmentId)
          ? stored.filter((entry) => entry.environmentId !== environmentId)
          : stored,
      ).pipe(Effect.asVoid),
  };
}

export class ThreadTriageOutboxStore extends Context.Reference<ThreadTriageOutboxStoreShape>(
  "@goat/client-runtime/state/ThreadTriageOutboxStore",
  {
    defaultValue: () => {
      let value: string | null = null;
      return makeThreadTriageOutboxStore((next) =>
        Effect.sync(() => {
          value = next(value) ?? value;
        }),
      );
    },
  },
) {}
