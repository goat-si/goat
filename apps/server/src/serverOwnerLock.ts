/**
 * Holds `<userdata>/server-owner.lock` for a server's whole lifetime.
 *
 * The lock admits one server per userdata directory and records each owner in its generation
 * log. The service launcher reads that log before it restores a database snapshot, so a
 * server that ran on the same data between an update's backup and its rollback keeps its
 * writes (see `serviceLauncher.ts`). A server only appears in the log if it takes the lock here.
 */
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import {
  decodeServiceLauncherContext,
  type ServiceLauncherContext,
} from "./cloud/serviceProtocol.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

/** How long a server outside the service waits for an owner that is shutting down. */
const SERVER_OWNER_HANDOFF_GRACE = Duration.seconds(15);
const POLL_INTERVAL = Duration.seconds(1);

class ServerOwnerConflictError extends Schema.TaggedError<ServerOwnerConflictError>()(
  "ServerOwnerConflictError",
  {
    stateDir: Schema.String,
    pid: Schema.optional(Schema.Number),
    origin: Schema.optional(Schema.String),
  },
) {
  // A supervisor such as the desktop app restarts any other exit code, so without this a
  // second app on the same data respawns its server every few seconds forever.
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    const holder =
      this.pid === undefined
        ? ""
        : ` (pid ${this.pid}${this.origin === undefined ? "" : `, ${this.origin}`})`;
    return `Another GOAT server is using ${this.stateDir}${holder}. Connect to that server, or stop it before starting another.`;
  }
}

class ServerOwnerLockError extends Schema.TaggedError<ServerOwnerLockError>()(
  "ServerOwnerLockError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to take ownership of ${this.stateDir}.`;
  }
}

/**
 * The owner tag recorded in the generation log. A launcher trial must use
 * `service-trial:<updateId>`: the launcher treats every other tag after its backup as
 * another server's writes.
 */
export const serverOwnerTag = (input: {
  readonly launcherContext: ServiceLauncherContext | undefined;
  readonly mode: string;
  readonly sshReplacementId?: string | undefined;
}): string => {
  const context = input.launcherContext;
  if (context === undefined) {
    return input.sshReplacementId === undefined
      ? `server:${input.mode}`
      : sshReplacementOwner(input.sshReplacementId);
  }
  const update = context.update;
  if (update?.status === "pending" && update.targetVersion === context.childVersion) {
    return `service-trial:${update.id}`;
  }
  if (context.probation === true && update?.status === "committed") {
    return `service-probation:${update.id}`;
  }
  return `service:${context.childVersion}`;
};

export const launcherContextFromEnvironment = (
  raw: string | undefined,
): ServiceLauncherContext | undefined =>
  raw === undefined ? undefined : decodeServiceLauncherContext(raw);

/**
 * The SSH replacement supervisor (`__ssh-helper supervise`) passes its replacement id to the
 * server it starts, so its rollback can tell that server's writes from another owner's.
 */
export const SSH_REPLACEMENT_ID_ENV = "GOAT_SSH_REPLACEMENT_ID";
export const sshSupervisorOwner = (replacementId: string) => `ssh-supervisor:${replacementId}`;
export const sshReplacementOwner = (replacementId: string) => `ssh-replacement:${replacementId}`;

/**
 * Takes the lock and keeps it until the caller's scope closes. A service-managed server waits
 * for a foreign owner instead of crash-looping under its service manager; any other server
 * waits out `handoffGrace` for a predecessor that is exiting, then fails.
 */
export const acquireServerOwnerLock = Effect.fn("server.acquireServerOwnerLock")(function* (input: {
  readonly stateDir: string;
  readonly owner: string;
  readonly serverRuntimeStatePath: string;
  readonly waitForOwner: boolean;
  readonly handoffGrace?: Duration.Duration;
  readonly pollInterval?: Duration.Duration;
}) {
  const grace = Duration.toMillis(input.handoffGrace ?? SERVER_OWNER_HANDOFF_GRACE);
  const poll = input.pollInterval ?? POLL_INTERVAL;
  let waitedMs = 0;
  let announced = false;
  while (true) {
    // Only a successful attempt registers a release, so a long wait adds no finalizers.
    const generation = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const lock = yield* Effect.try({
          try: () => tryAcquireServerOwnerLock(input.stateDir, input.owner),
          catch: (cause) => new ServerOwnerLockError({ stateDir: input.stateDir, cause }),
        });
        if (lock === undefined) return undefined;
        yield* Effect.addFinalizer(() => Effect.sync(() => lock.release()));
        return lock.generation;
      }),
    );
    if (generation !== undefined) return generation;

    if (!input.waitForOwner && waitedMs >= grace) {
      const holder = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      return yield* new ServerOwnerConflictError({
        stateDir: input.stateDir,
        ...(holder === undefined ? {} : { pid: holder.pid, origin: holder.origin }),
      });
    }
    if (!announced) {
      announced = true;
      yield* Effect.logInfo("Waiting for the GOAT server using this data to exit", {
        stateDir: input.stateDir,
      });
    }
    yield* Effect.sleep(poll);
    waitedMs += Duration.toMillis(poll);
  }
});
