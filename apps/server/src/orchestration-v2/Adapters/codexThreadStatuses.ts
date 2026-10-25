import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

/** Added to a turn whose computer use change waits for a quiet conversation (#1564). */
export const CUA_DEFERRED_NOTE =
  "This conversation's computer use connection changed (for example after Stop), and the change applies only once this conversation and its subagents are idle and none of their goals is active. Until then computer use keeps its previous connection, which may refuse calls. If it does, tell the person to send their next message after this turn ends (pausing an active goal first), or to start a new thread.";

/**
 * What Codex last reported for each native thread, from thread/status/changed and thread/start.
 * Only a thread reported idle, notLoaded or systemError is quiet; an unreported one is not. Codex answers
 * turn/start before the new turn's own notifications, and a finished turn's notifications can
 * arrive after that answer, so a start stays pending until turn/started names its turn.
 */
// Codex reports a loaded thread whose last turn failed as systemError until its next turn: like
// idle, nothing runs or waits there.
const QUIET = new Set(["idle", "notLoaded", "systemError"]);

export function makeCodexThreadStatuses() {
  const statuses = new Map<string, string>();
  const lastStarted = new Map<string, string>();
  // The turn a thread waits to see start; null until Codex answers turn/start.
  const pending = new Map<string, string | null>();
  // Threads a reload unsubscribed whose resume has not succeeded since: Codex has dropped them.
  const unloaded = new Set<string>();
  const quiet = (threadId: string) => {
    const status = statuses.get(threadId);
    return !pending.has(threadId) && status !== undefined && QUIET.has(status);
  };
  return {
    /**
     * Whether a reload now could drop work or be ignored: a thread is not reported quiet, a goal
     * is active, or (with terminals) a background terminal runs. The statuses are read again after
     * every request to Codex, since a turn can start meanwhile. An unloaded thread cannot run, so
     * only loaded ones are asked.
     */
    busy: (
      client: CodexClient.CodexAppServerClient["Service"],
      threadIds: ReadonlyArray<string>,
      terminals: boolean,
    ) => {
      // Codex resumes a thread cold only from idle: a root left in systemError keeps its old
      // configuration through unsubscribe and resume, so it waits for its next turn (#1569).
      const settled = () =>
        statuses.get(threadIds[0] ?? "") !== "systemError" && threadIds.every(quiet);
      const loaded = threadIds.filter((threadId) => statuses.get(threadId) !== "notLoaded");
      return settled()
        ? codexGoalsActive(client, loaded).pipe(
            Effect.flatMap((active) =>
              active || !terminals ? Effect.succeed(active) : terminalsRunning(client, loaded),
            ),
            Effect.map((busy) => busy || !settled()),
          )
        : Effect.succeed(true);
    },
    /**
     * Rebuilds a thread from these overrides: without a subscriber Codex drops the loaded thread, and
     * the resume loads it again. A failed resume leaves it dropped until one succeeds.
     */
    reload: (
      client: CodexClient.CodexAppServerClient["Service"],
      threadId: string,
      params: Record<string, unknown>,
    ) =>
      client
        .request("thread/unsubscribe", { threadId })
        .pipe(
          Effect.andThen(Effect.sync(() => unloaded.add(threadId))),
          Effect.andThen(
            client.raw.request("thread/resume", { threadId, excludeTurns: true, ...params }),
          ),
          Effect.andThen(Effect.sync(() => unloaded.delete(threadId))),
        ),
    /** Whether a failed reload left this thread dropped, so only a resume can serve its next turn. */
    dropped: (threadId: string) => unloaded.has(threadId),
    resumed: (threadId: string) => void unloaded.delete(threadId),
    record: (threadId: string, status: string) => void statuses.set(threadId, status),
    turnStarted: (threadId: string, turnId: string) => {
      lastStarted.set(threadId, turnId);
      if (pending.get(threadId) === turnId) pending.delete(threadId);
    },
    starting: (threadId: string) => {
      pending.set(threadId, null);
      return {
        failed: () => void pending.delete(threadId),
        // A folded input names the turn already running, whose start was seen.
        answered: (turnId: string) =>
          void (lastStarted.get(threadId) === turnId
            ? pending.delete(threadId)
            : pending.set(threadId, turnId)),
      };
    },
  };
}

// Codex refuses goal requests when the goals feature is off or the thread is ephemeral, and older
// app servers lack the method: none of these threads can have a goal.
const hasNoGoals = (error: CodexErrors.CodexAppServerRequestError) =>
  error.code === -32601 ||
  (error.code === -32600 &&
    (error.errorMessage === "goals feature is disabled" ||
      error.errorMessage.startsWith("ephemeral thread does not support goals")));

/**
 * Whether any of these threads has an active goal, which lets Codex start a continuation turn on
 * its own. Goal notifications can arrive late or out of order, so this asks Codex, which reads its
 * own goal store; an unexplained failure counts as active and defers the reload.
 */
const codexGoalsActive = (
  client: CodexClient.CodexAppServerClient["Service"],
  threadIds: ReadonlyArray<string>,
) =>
  Effect.forEach(threadIds, (threadId) =>
    client.request("thread/goal/get", { threadId }).pipe(
      Effect.map(({ goal }) => goal?.status === "active"),
      Effect.catchTags({
        CodexAppServerRequestError: (error) => Effect.succeed(!hasNoGoals(error)),
      }),
      Effect.catch(() => Effect.succeed(true)),
    ),
  ).pipe(Effect.map((active) => active.includes(true)));

/**
 * Whether any of these threads keeps a background terminal, such as a dev server, which a reload
 * would stop. Asked of Codex; only an older Codex without the method counts as none.
 */
const terminalsRunning = (
  client: CodexClient.CodexAppServerClient["Service"],
  threadIds: ReadonlyArray<string>,
) =>
  Effect.forEach(threadIds, (threadId) =>
    client.raw.request("thread/backgroundTerminals/list", { threadId }).pipe(
      Effect.map((page) => {
        const data = (page as { readonly data?: unknown } | null)?.data;
        return !Array.isArray(data) || data.length > 0;
      }),
      Effect.catchTags({
        CodexAppServerRequestError: (error) => Effect.succeed(error.code !== -32601),
      }),
      Effect.catch(() => Effect.succeed(true)),
    ),
  ).pipe(Effect.map((running) => running.includes(true)));
