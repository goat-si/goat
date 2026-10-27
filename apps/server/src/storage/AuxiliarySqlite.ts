// @effect-diagnostics nodeBuiltinImport:off -- native SQLite lives only in the inline worker.
import * as NodeWorkerThreads from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ImessageRow } from "../channels/imessage/imessageChatDb.ts";
import { source } from "./AuxiliarySqliteWorkerSource.ts";

export type AuxiliaryRead =
  | { readonly kind: "worktrees" | "bindings"; readonly file: string }
  | { readonly kind: "imessage-max"; readonly file: string }
  | {
      readonly kind: "imessage-rows";
      readonly file: string;
      readonly cursor: number;
      readonly limit: number;
    }
  | { readonly kind: "imessage-row"; readonly file: string; readonly rowId: number };

export interface AuxiliaryRows {
  readonly worktreePaths: ReadonlyArray<string>;
  readonly projectRoots: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ImessageRow>;
  readonly max: number;
}

export class AuxiliarySqliteError extends Schema.TaggedError<AuxiliarySqliteError>()(
  "AuxiliarySqliteError",
  { category: Schema.Literals(["database_unavailable", "schema_unsupported", "query_failed"]) },
) {
  override get message() {
    return "Auxiliary SQLite " + this.category;
  }
}

export class AuxiliarySqlite extends Context.Service<
  AuxiliarySqlite,
  {
    readonly read: (input: AuxiliaryRead) => Effect.Effect<AuxiliaryRows, AuxiliarySqliteError>;
  }
>()("goat/storage/AuxiliarySqlite") {}

export class WorkerLauncher extends Context.Service<
  WorkerLauncher,
  {
    readonly start: (
      input: AuxiliaryRead,
      receipts: {
        readonly message: (value: unknown) => void;
        readonly error: () => void;
        readonly exit: (code: number) => void;
      },
    ) => { readonly terminate: () => void; readonly detach: () => void };
  }
>()("goat/storage/AuxiliarySqlite/WorkerLauncher") {}

const workerLauncher = Layer.succeed(WorkerLauncher, {
  start: (input, receipts) => {
    const worker = new NodeWorkerThreads.Worker(source, { eval: true, workerData: input });
    worker.on("message", receipts.message);
    worker.on("error", receipts.error);
    worker.once("exit", receipts.exit);
    return {
      terminate: () => {
        void worker.terminate().catch(receipts.error);
      },
      detach: () => {
        worker.off("message", receipts.message);
      },
    };
  },
});

const nullableText = Schema.NullOr(Schema.String);
const nullableNumber = Schema.NullOr(Schema.Number);
const rowSchema = Schema.Struct({
  rowid: Schema.Int,
  guid: nullableText,
  text: nullableText,
  attributedBody: Schema.NullOr(Schema.instanceOf(Uint8Array)),
  handle_id: nullableNumber,
  is_from_me: Schema.Number,
  date: Schema.Number,
  date_read: nullableNumber,
  cache_roomnames: nullableText,
  associated_message_type: nullableNumber,
  item_type: nullableNumber,
  balloon_bundle_id: nullableText,
  sender_handle: nullableText,
  sender_service: nullableText,
  chat_rowid: nullableNumber,
  chat_guid: nullableText,
  chat_identifier: nullableText,
  style: nullableNumber,
  chat_join_count: Schema.Int,
});
const replySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("complete"),
    output: Schema.Struct({
      worktreePaths: Schema.Array(Schema.String),
      projectRoots: Schema.Array(Schema.String),
      rows: Schema.Array(rowSchema),
      max: Schema.Int,
    }),
  }),
  Schema.Struct({ type: Schema.Literal("failed"), category: AuxiliarySqliteError.fields.category }),
]);
const decodeReply = Schema.decodeUnknownSync(replySchema);
const failure = () => new AuxiliarySqliteError({ category: "query_failed" });

const validInput = (input: AuxiliaryRead) => {
  if (input.kind === "imessage-rows")
    return (
      Number.isSafeInteger(input.cursor) &&
      input.cursor >= 0 &&
      Number.isSafeInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= 50
    );
  if (input.kind === "imessage-row") return Number.isSafeInteger(input.rowId) && input.rowId >= 1;
  return true;
};

const validateRows = (input: AuxiliaryRead, output: AuxiliaryRows) => {
  const ownership = input.kind === "worktrees" || input.kind === "bindings";
  if (
    !Number.isSafeInteger(output.max) ||
    output.max < 0 ||
    output.worktreePaths.length + output.projectRoots.length + output.rows.length > 100_000 ||
    (ownership
      ? output.rows.length !== 0
      : output.worktreePaths.length + output.projectRoots.length !== 0)
  )
    throw failure();
  if (input.kind === "imessage-max" && output.rows.length !== 0) throw failure();
  if (
    input.kind === "imessage-row" &&
    (output.rows.length > 1 || output.rows.some((row) => row.rowid !== input.rowId))
  )
    throw failure();
  if (input.kind === "imessage-rows") {
    if (output.rows.length > input.limit) throw failure();
    let previous = input.cursor;
    for (const row of output.rows) {
      if (!Number.isSafeInteger(row.rowid) || row.rowid <= previous) throw failure();
      previous = row.rowid;
    }
  }
  let bytes = 0;
  for (const value of [...output.worktreePaths, ...output.projectRoots])
    bytes += Buffer.byteLength(value);
  for (const row of output.rows)
    for (const value of Object.values(row)) {
      bytes +=
        typeof value === "string"
          ? Buffer.byteLength(value)
          : value instanceof Uint8Array
            ? value.byteLength
            : 8;
    }
  if (bytes > 8 * 1024 * 1024) throw failure();
  return output;
};

export const layerWithLauncher = Layer.effect(
  AuxiliarySqlite,
  Effect.gen(function* () {
    const launcher = yield* WorkerLauncher;
    const jobs = new Set<{ readonly stop: () => void }>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        for (const job of jobs) job.stop();
      }),
    );
    const read = Effect.fn("AuxiliarySqlite.read")(function* (input: AuxiliaryRead) {
      if (closed || jobs.size >= 2 || !validInput(input)) return yield* Effect.fail(failure());
      return yield* Effect.callback<AuxiliaryRows, AuxiliarySqliteError>((resume) => {
        let listening = true;
        let retired = false;
        let terminationRequested = false;
        let output: AuxiliaryRows | undefined;
        let handle: ReturnType<WorkerLauncher["Service"]["start"]> | undefined;
        const finish = (result: Effect.Effect<AuxiliaryRows, AuxiliarySqliteError>) => {
          if (!listening) return;
          listening = false;
          handle?.detach();
          resume(result);
        };
        const stop = () => {
          finish(Effect.fail(failure()));
          if (!retired && !terminationRequested) {
            terminationRequested = true;
            handle?.terminate();
          }
        };
        const job = { stop };
        // A timed-out worker still owns capacity until its actual exit receipt.
        jobs.add(job);
        try {
          handle = launcher.start(input, {
            message: (value) => {
              if (!listening) return;
              try {
                const reply = decodeReply(value);
                if (reply.type === "failed") {
                  finish(Effect.fail(new AuxiliarySqliteError({ category: reply.category })));
                  stop();
                } else {
                  if (output !== undefined) throw failure();
                  output = validateRows(input, reply.output);
                }
              } catch {
                stop();
              }
            },
            error: stop,
            exit: (code) => {
              retired = true;
              jobs.delete(job);
              finish(
                code === 0 && output !== undefined
                  ? Effect.succeed(output)
                  : Effect.fail(failure()),
              );
            },
          });
          if (!listening) handle.detach();
          if (terminationRequested && !retired) handle.terminate();
        } catch {
          jobs.delete(job);
          retired = true;
          finish(Effect.fail(failure()));
        }
        return Effect.sync(stop);
      }).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(failure()) }),
      );
    });
    return AuxiliarySqlite.of({ read });
  }),
);

export const layer = layerWithLauncher.pipe(Layer.provide(workerLauncher));
