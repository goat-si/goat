import {
  AUTOMATION_HOLD_FILE_NAME,
  decodeAutomationHold,
  type AutomationHold as AutomationHoldState,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class AutomationHoldReleaseError extends Schema.TaggedError<AutomationHoldReleaseError>()(
  "AutomationHoldReleaseError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not resume automation: removing ${this.path} failed.`;
  }
}

/**
 * Whether this server's automation may act. While held, nothing here may act on its own: no
 * scheduled task, channel bot, goal or fleet dispatch, hub or link membership, or continuation of
 * work the copied state was in the middle of. A person's own requests still run.
 *
 * Read it where automation starts, the way ServerActivation is read: the default is never held,
 * so tests and transports that do not care need not provide it.
 */
export class AutomationHold extends Context.Reference<{
  readonly current: Effect.Effect<AutomationHoldState | null>;
  /** The current state first, then every change. */
  readonly changes: Stream.Stream<AutomationHoldState | null>;
  /** Completes once nothing holds automation; at once when nothing does. */
  readonly awaitRelease: Effect.Effect<void>;
  /** Removes the hold file, then wakes everything waiting. Idempotent. */
  readonly release: Effect.Effect<void, AutomationHoldReleaseError>;
}>("goat/AutomationHold", {
  defaultValue: () => ({
    current: Effect.succeed(null),
    changes: Stream.make(null),
    awaitRelease: Effect.void,
    release: Effect.void,
  }),
}) {}

export const isHeld = Effect.gen(function* () {
  return (yield* (yield* AutomationHold).current) !== null;
});

export const awaitRelease = Effect.gen(function* () {
  yield* (yield* AutomationHold).awaitRelease;
});

const make = Effect.fn("AutomationHold.make")(function* (
  initial: AutomationHoldState | null,
  remove: Effect.Effect<void, AutomationHoldReleaseError>,
) {
  const state = yield* SubscriptionRef.make(initial);
  const lock = yield* Semaphore.make(1);
  const changes = SubscriptionRef.changes(state);
  return AutomationHold.of({
    current: SubscriptionRef.get(state),
    changes,
    awaitRelease: changes.pipe(
      Stream.filter((value) => value === null),
      Stream.take(1),
      Stream.runDrain,
    ),
    // The file goes first: a release that could not persist must not let the copy act now and
    // then hold again at the next start.
    release: lock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(state)) === null) return;
        yield* remove;
        yield* SubscriptionRef.set(state, null);
        yield* Effect.logInfo("Automation resumed on this server");
      }),
    ),
  });
});

/** In memory, for tests that drive a hold directly. */
export const makeInMemory = (initial: AutomationHoldState | null) => make(initial, Effect.void);

/** Reads `<stateDir>/automation-hold.json`. A file that cannot be read still holds automation. */
export const makeFromStateDir = Effect.fn("AutomationHold.makeFromStateDir")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const holdPath = path.join(stateDir, AUTOMATION_HOLD_FILE_NAME);
  const raw = yield* fs.readFileString(holdPath).pipe(
    Effect.map((contents): string | null => contents),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the automation hold; holding automation", { cause }).pipe(
        Effect.as(""),
      ),
    ),
  );
  let initial: AutomationHoldState | null = null;
  if (raw !== null) {
    try {
      initial = decodeAutomationHold(raw);
    } catch (cause) {
      yield* Effect.logWarning("Unreadable automation hold; holding automation", { cause });
      initial = { reason: "channel-copy", heldAt: "" };
    }
    yield* Effect.logInfo("Automation is held until it is resumed in Settings", {
      reason: initial.reason,
      heldAt: initial.heldAt,
    });
  }
  return yield* make(
    initial,
    fs.remove(holdPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
      Effect.mapError((cause) => new AutomationHoldReleaseError({ path: holdPath, cause })),
    ),
  );
});
