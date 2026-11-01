import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

const MaintenanceActor = Schema.Struct({
  kind: Schema.String,
  sessionId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});
export type MaintenanceActor = typeof MaintenanceActor.Type;

const Entry = Schema.Struct({
  ts: Schema.String,
  operationId: Schema.String,
  operation: Schema.Literals(["server-update", "ssh-runtime-update"]),
  actor: MaintenanceActor,
  fromVersion: Schema.NullOr(Schema.String),
  targetVersion: Schema.String,
  destination: Schema.optionalKey(Schema.String),
  mode: Schema.Literals(["idle", "confirmed"]),
  outcome: Schema.Literals(["requested", "accepted", "failed", "completed"]),
  updateId: Schema.optionalKey(Schema.String),
});
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(Entry));

export class MaintenanceAuditError extends Schema.TaggedError<MaintenanceAuditError>()(
  "MaintenanceAuditError",
  { cause: Schema.Defect() },
) {}

export class MaintenanceAudit extends Context.Service<
  MaintenanceAudit,
  {
    readonly append: (
      entry: Omit<typeof Entry.Type, "ts">,
    ) => Effect.Effect<void, MaintenanceAuditError>;
  }
>()("goat/maintenance/MaintenanceAudit") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  return MaintenanceAudit.of({
    append: (entry) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
          const file = yield* fs.open(path.join(config.stateDir, "maintenance-audit.jsonl"), {
            flag: "a",
            mode: 0o600,
          });
          const ts = DateTime.formatIso(yield* DateTime.now);
          yield* file.writeAll(new TextEncoder().encode(`${encodeEntry({ ts, ...entry })}\n`));
          // The launcher can stop this process immediately after accepting the request.
          yield* file.sync;
        }),
      ).pipe(
        lock.withPermits(1),
        Effect.uninterruptible,
        Effect.mapError((cause) => new MaintenanceAuditError({ cause })),
      ),
  });
});

export const layer = Layer.effect(MaintenanceAudit, make);
