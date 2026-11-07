import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

/** Added to a turn whose computer use change waits for a quiet conversation (#1564). */
export const CUA_DEFERRED_NOTE =
  "This conversation's computer use driver configuration changed, and the change applies only once this conversation and its subagents are idle and none of their goals is active. Until then computer use keeps its previous connection, which may refuse calls. If it does, tell the person why: ending this turn and pausing an active goal let their next message apply the change. When their subagent limit changed too, it also waits until none of them keeps a background terminal running, such as a dev server; they need to finish or stop that work first, or start a new thread.";

/** Added to the turn that reloaded a conversation Codex held across a GOAT server restart. */
export const RESTART_RELOAD_NOTE =
  "GOAT restarted while Codex kept this conversation loaded, so this turn reloaded the conversation to give GOAT tools a working credential. Any background terminal it kept running, such as a dev server, has stopped; start it again if this work still needs it.";

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
  // Counts what Codex reported about each thread's activity: a status change, a turn start or a
  // turn/start of ours. A thread can work and go idle between two reads of its status (#1658).
  const revisions = new Map<string, number>();
  // The last turn Codex reported ended on each thread.
  const lastCompleted = new Map<string, string>();
  // Threads Codex reported busy again after the last turn GOAT saw ended (or with none seen, as on
  // a resume), until that turn's start, its end or a quiet report arrives.
  const unseen = new Set<string>();
  // Waiters for a thread to stop working; each checks its own condition on every change.
  const quietWaiters = new Map<string, Set<() => void>>();
  const bump = (threadId: string) => revisions.set(threadId, (revisions.get(threadId) ?? 0) + 1);
  const wakeIfQuiet = (threadId: string) => {
    for (const wake of quietWaiters.get(threadId) ?? []) wake();
  };
  /**
   * Whether a turn is in progress on this thread: the turn Codex last started has not ended while
   * Codex reports the thread busy (an idle report can arrive after the turn ends), Codex went busy
   * again with a turn GOAT has not seen start, or a start of ours has not started its turn, unless
   * GOAT already gave up on that start.
   */
  const working = (threadId: string, abandoned: (turnId: string) => boolean) => {
    const status = statuses.get(threadId);
    const running = lastStarted.get(threadId);
    const start = pending.get(threadId);
    return (
      unseen.has(threadId) ||
      (running !== undefined &&
        lastCompleted.get(threadId) !== running &&
        (status === undefined || !QUIET.has(status))) ||
      (pending.has(threadId) && (start == null || !abandoned(start)))
    );
  };
  const quiet = (threadId: string) => {
    const status = statuses.get(threadId);
    return !pending.has(threadId) && status !== undefined && QUIET.has(status);
  };
  const record = (threadId: string, status: string) => {
    const previous = statuses.get(threadId);
    if (previous !== status) bump(threadId);
    const seen = lastStarted.get(threadId);
    if (QUIET.has(status)) unseen.delete(threadId);
    // Only a change from quiet tells a new turn apart from a busy report the last one left behind.
    else if (
      previous === undefined
        ? seen === undefined
        : QUIET.has(previous) && (seen === undefined || lastCompleted.get(threadId) === seen)
    )
      unseen.add(threadId);
    statuses.set(threadId, status);
    wakeIfQuiet(threadId);
  };
  return {
    working,
    /** Whether a turn/start of ours has not yet seen its turn start. */
    startPending: (threadId: string) => pending.has(threadId),
    lastStarted: (threadId: string) => lastStarted.get(threadId),
    /** The turn Codex last started on this thread, while it has not reported that turn ended. */
    runningTurn: (threadId: string) => {
      const running = lastStarted.get(threadId);
      return unseen.has(threadId) || running === lastCompleted.get(threadId) ? undefined : running;
    },
    /** Resolves once no turn is in progress on the thread; at once when none is. */
    whenQuiet: (threadId: string, abandoned: (turnId: string) => boolean) =>
      Effect.callback<void>((resume) => {
        if (!working(threadId, abandoned)) return resume(Effect.void);
        const forget = () => {
          waiters.delete(wake);
          if (waiters.size === 0 && quietWaiters.get(threadId) === waiters)
            quietWaiters.delete(threadId);
        };
        const wake = () => {
          if (working(threadId, abandoned)) return;
          forget();
          resume(Effect.void);
        };
        const waiters = quietWaiters.get(threadId) ?? new Set<() => void>();
        waiters.add(wake);
        quietWaiters.set(threadId, waiters);
        return Effect.sync(forget);
      }),
    /**
     * Whether a reload now could drop work or be ignored: a thread is not reported quiet, a goal
     * is active, or (with terminals) a background terminal runs. Codex is asked one thread at a
     * time, and a thread already asked about can run a turn meanwhile, start a dev server and go
     * idle again, so any activity reported since the check began counts as busy. An unloaded
     * thread cannot run, so only loaded ones are asked.
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
      const before = threadIds.map((threadId) => revisions.get(threadId) ?? 0);
      const worked = () =>
        threadIds.some((threadId, index) => (revisions.get(threadId) ?? 0) !== before[index]);
      const loaded = threadIds.filter((threadId) => statuses.get(threadId) !== "notLoaded");
      return settled()
        ? codexGoalsActive(client, loaded).pipe(
            Effect.flatMap((active) =>
              active || !terminals ? Effect.succeed(active) : terminalsRunning(client, loaded),
            ),
            Effect.map((busy) => busy || !settled() || worked()),
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
    record,
    /** GOAT stopped listening to this thread: what it saw says nothing about what runs from now. */
    forget: (threadId: string) => {
      statuses.delete(threadId);
      lastStarted.delete(threadId);
      lastCompleted.delete(threadId);
      unseen.delete(threadId);
    },
    turnCompleted: (threadId: string, turnId: string) => {
      // A turn GOAT never saw start, such as one running across a restart, ended here.
      const seen = lastStarted.get(threadId);
      if (turnId !== seen && (unseen.delete(threadId) || seen === undefined))
        lastStarted.set(threadId, turnId);
      lastCompleted.set(threadId, turnId);
      wakeIfQuiet(threadId);
    },
    turnStarted: (threadId: string, turnId: string) => {
      bump(threadId);
      unseen.delete(threadId);
      lastStarted.set(threadId, turnId);
      if (pending.get(threadId) === turnId) pending.delete(threadId);
      wakeIfQuiet(threadId);
    },
    starting: (threadId: string) => {
      bump(threadId);
      pending.set(threadId, null);
      return {
        failed: () => {
          pending.delete(threadId);
          wakeIfQuiet(threadId);
        },
        // A folded input names the turn already running, whose start was seen.
        answered: (turnId: string) => {
          if (lastStarted.get(threadId) === turnId) pending.delete(threadId);
          else pending.set(threadId, turnId);
          wakeIfQuiet(threadId);
        },
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
