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
    status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
  }),
});
const decodeLoadedThreadPage = Schema.decodeUnknownEffect(LoadedThreadPage);
const decodeLoadedThread = Schema.decodeUnknownEffect(LoadedThread);

/**
 * Adds to a held conversation the loaded threads that descend from its root, with the status Codex
 * reports for each. Subagents that survived a restart are unknown to this session, and GOAT does
 * not hear their status, so it asks Codex at every turn. False when Codex could not tell.
 */
export const addSurvivingDescendants = Effect.fn("CodexAdapterV2.addSurvivingDescendants")(
  function* (
    raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
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
    const parents = new Map<string, { readonly parent: string; readonly status: string }>();
    for (const threadId of loaded) {
      if (conversation.includes(threadId)) continue;
      const { thread } = yield* raw
        .request("thread/read", { threadId, includeTurns: false })
        .pipe(Effect.flatMap(decodeLoadedThread));
      if (thread.parentThreadId != null)
        parents.set(threadId, { parent: thread.parentThreadId, status: thread.status?.type ?? "" });
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const [threadId, { parent, status }] of parents)
        if (!conversation.includes(threadId) && conversation.includes(parent)) {
          statuses.record(threadId, status);
          conversation.push(threadId);
          grew = true;
        }
    }
    return true;
  },
  // An older Codex without the method holds no subagents it could list.
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        CodexAppServerRequestError: (error) => Effect.succeed(error.code === -32601),
      }),
      Effect.orElseSucceed(() => false),
    ),
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
  if (!(yield* addSurvivingDescendants(client.raw, statuses, conversation))) return true;
  return yield* statuses.busy(client, conversation, false);
});
