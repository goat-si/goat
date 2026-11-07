import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { makeCodexThreadStatuses } from "./codexThreadStatuses.ts";

/** Generated thread/read schemas omit historyMode; probe through the raw request channel. */
const CodexThreadHistoryMetadata = Schema.Struct({
  thread: Schema.Struct({
    historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
  }),
});
const decodeCodexThreadHistoryMetadata = Schema.decodeUnknownEffect(CodexThreadHistoryMetadata);

export const readCodexThreadHistoryMetadata = Effect.fn("CodexAdapterV2.readThreadHistoryMetadata")(
  function* (
    raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
    threadId: string,
  ) {
    const response = yield* raw.request("thread/read", { threadId, includeTurns: false });
    const metadata = yield* decodeCodexThreadHistoryMetadata(response).pipe(
      Effect.mapError((error) =>
        CodexErrors.CodexAppServerRequestError.invalidPayload(
          "thread/read",
          "decode-payload",
          error,
        ),
      ),
    );
    return {
      historyMode: metadata.thread.historyMode,
      loaded: metadata.thread.status?.type !== "notLoaded",
    };
  },
);

/**
 * Whether Codex holds this thread loaded already. Codex keeps a held thread's configuration through
 * thread/resume (it rebuilds only a quiet one no client holds), so a resume installs GOAT's
 * credential only when this is false. An unreadable answer counts as held. A held thread is resumed
 * without overrides, so Codex only rejoins it; the next quiet turn reloads it under GOAT's checks.
 */
export const codexThreadHeld = (
  raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
  threadId: string,
) =>
  readCodexThreadHistoryMetadata(raw, threadId).pipe(
    Effect.map((metadata) => metadata.loaded),
    Effect.orElseSucceed(() => true),
  );

const LoadedThreadPage = Schema.Struct({
  data: Schema.Array(Schema.String),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const LoadedThread = Schema.Struct({
  thread: Schema.Struct({
    parentThreadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    source: Schema.optionalKey(Schema.Unknown),
    status: Schema.Struct({ type: Schema.String }),
    updatedAt: Schema.Number,
  }),
});
const decodeLoadedThreadPage = Schema.decodeUnknownEffect(LoadedThreadPage);
const decodeLoadedThread = Schema.decodeUnknownEffect(LoadedThread);
const QUIET = new Set(["idle", "notLoaded", "systemError"]);

/** A subagent names its parent in `parentThreadId` or only in the spawn record of its source. */
const parentOf = (thread: (typeof LoadedThread.Type)["thread"]) => {
  if (thread.parentThreadId != null) return thread.parentThreadId;
  const source = thread.source as
    | { readonly subAgent?: { readonly thread_spawn?: { readonly parent_thread_id?: unknown } } }
    | null
    | undefined;
  const parent =
    typeof source === "object" ? source?.subAgent?.thread_spawn?.parent_thread_id : undefined;
  return typeof parent === "string" ? parent : undefined;
};

type Raw = Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
type Survivor = { readonly threadId: string; readonly status: string; readonly updatedAt: number };

const readLoaded = (raw: Raw, threadId: string) =>
  raw
    .request("thread/read", { threadId, includeTurns: false })
    .pipe(Effect.flatMap(decodeLoadedThread));

/**
 * The loaded threads that descend from a held conversation, as Codex reports them now. Subagents
 * that survived a restart are unknown to this session, and GOAT does not hear their status, so it
 * asks Codex. Undefined when Codex could not tell.
 */
const loadedDescendants = Effect.fn("CodexAdapterV2.loadedDescendants")(
  function* (raw: Raw, roots: ReadonlyArray<string>) {
    const loaded: Array<string> = [];
    let cursor: string | null | undefined;
    do {
      const page = yield* raw
        .request("thread/loaded/list", cursor == null ? {} : { cursor })
        .pipe(Effect.flatMap(decodeLoadedThreadPage));
      loaded.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor != null);
    const children = new Map<string, Survivor & { readonly parent: string }>();
    for (const threadId of loaded) {
      if (roots.includes(threadId)) continue;
      const { thread } = yield* readLoaded(raw, threadId);
      const parent = parentOf(thread);
      if (parent !== undefined)
        children.set(threadId, {
          threadId,
          parent,
          status: thread.status.type,
          updatedAt: thread.updatedAt,
        });
    }
    const tree = new Set(roots);
    const survivors: Array<Survivor> = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const child of children.values())
        if (!tree.has(child.threadId) && tree.has(child.parent)) {
          tree.add(child.threadId);
          survivors.push(child);
          grew = true;
        }
    }
    return survivors;
  },
  // An older Codex without the method holds no subagents it could list.
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        CodexAppServerRequestError: (error) =>
          Effect.succeed(error.code === -32601 ? [] : undefined),
      }),
      Effect.orElseSucceed(() => undefined),
    ),
);

/**
 * Whether the second look at the survivors matches the first: the same threads, each still quiet
 * with the same status and update time. A descendant started in between is listed now; Codex keeps
 * update times in whole seconds, so a match proves only that nothing new runs.
 */
const survivorsSettled = (
  first: ReadonlyArray<Survivor>,
  second: ReadonlyArray<Survivor> | undefined,
) =>
  second !== undefined &&
  second.length === first.length &&
  second.every((survivor) => {
    const before = first.find((entry) => entry.threadId === survivor.threadId);
    return (
      before !== undefined &&
      QUIET.has(survivor.status) &&
      survivor.status === before.status &&
      survivor.updatedAt === before.updatedAt
    );
  });

/**
 * Whether a reload must wait for this conversation. A held conversation first gains the surviving
 * subagents Codex lists, and counts as busy when Codex could not list them. Its credential is from an
 * earlier server and dead, so background terminals do not defer its reload.
 */
export const conversationBusy = Effect.fn("CodexAdapterV2.conversationBusy")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  statuses: ReturnType<typeof makeCodexThreadStatuses>,
  conversation: Array<string>,
  options: { readonly held: boolean; readonly terminals: boolean },
) {
  if (!options.held) return yield* statuses.busy(client, conversation, options.terminals);
  const roots = [...conversation];
  const survivors = yield* loadedDescendants(client.raw, roots);
  if (survivors === undefined) return true;
  for (const survivor of survivors) {
    statuses.record(survivor.threadId, survivor.status);
    conversation.push(survivor.threadId);
  }
  // GOAT hears nothing from survivors, so it looks again for anything that changed meanwhile, inside
  // the busy check's window so the threads it does hear from count while it looks.
  const changed = loadedDescendants(client.raw, roots).pipe(
    Effect.map((again) => !survivorsSettled(survivors, again)),
  );
  return yield* statuses.busy(client, conversation, false, changed);
});
