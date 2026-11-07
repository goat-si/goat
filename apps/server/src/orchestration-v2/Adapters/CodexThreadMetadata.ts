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
    status: Schema.Struct({ type: Schema.String }),
    updatedAt: Schema.Number,
  }),
});
const decodeLoadedThreadPage = Schema.decodeUnknownEffect(LoadedThreadPage);
const decodeLoadedThread = Schema.decodeUnknownEffect(LoadedThread);
const QUIET = new Set(["idle", "notLoaded", "systemError"]);

type Raw = Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
type Survivor = { readonly threadId: string; readonly status: string; readonly updatedAt: number };

const readLoaded = (raw: Raw, threadId: string) =>
  raw
    .request("thread/read", { threadId, includeTurns: false })
    .pipe(Effect.flatMap(decodeLoadedThread));

/**
 * Adds to a held conversation the loaded threads that descend from its root and records the status
 * Codex reports for each. Subagents that survived a restart are unknown to this session, and GOAT
 * does not hear their status, so it asks Codex at every turn. Undefined when Codex could not tell.
 */
const addSurvivingDescendants = Effect.fn("CodexAdapterV2.addSurvivingDescendants")(
  function* (
    raw: Raw,
    statuses: { readonly record: (threadId: string, status: string) => void },
    conversation: Array<string>,
  ) {
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
      if (conversation.includes(threadId)) continue;
      const { thread } = yield* readLoaded(raw, threadId);
      if (thread.parentThreadId != null)
        children.set(threadId, {
          threadId,
          parent: thread.parentThreadId,
          status: thread.status.type,
          updatedAt: thread.updatedAt,
        });
    }
    const survivors: Array<Survivor> = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const child of children.values())
        if (!conversation.includes(child.threadId) && conversation.includes(child.parent)) {
          statuses.record(child.threadId, child.status);
          conversation.push(child.threadId);
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

/** Whether each survivor is still quiet and unchanged since it was first read. */
const survivorsUnchanged = (raw: Raw, survivors: ReadonlyArray<Survivor>) =>
  Effect.forEach(survivors, (survivor) =>
    readLoaded(raw, survivor.threadId).pipe(
      Effect.map(
        ({ thread }) =>
          QUIET.has(thread.status.type) &&
          thread.status.type === survivor.status &&
          thread.updatedAt === survivor.updatedAt,
      ),
    ),
  ).pipe(
    Effect.map((unchanged) => unchanged.every(Boolean)),
    Effect.orElseSucceed(() => false),
  );

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
  const survivors = yield* addSurvivingDescendants(client.raw, statuses, conversation);
  if (survivors === undefined || (yield* statuses.busy(client, conversation, false))) return true;
  // GOAT hears nothing from survivors, so one that worked during the check is caught by a re-read.
  return !(yield* survivorsUnchanged(client.raw, survivors));
});
