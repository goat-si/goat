/**
 * An agent's request that a person finish a step on its tab or desktop: a clocked handoff record
 * plus an in-memory hold. Ending the hold on the screen settles the record; the record ending in
 * the thread releases the hold. A restart drops holds, so it cancels the records left behind.
 */
import {
  CommandId,
  type Handoff,
  type HandoffActor,
  isHandoffPending,
  type OrchestrationV2DomainEvent,
  OrchestratorMcpFailure,
  PREVIEW_HANDOFF_PATH,
  type PreviewRequestHandoffResult,
  type ProviderInstanceId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScreenRunService from "../screenCode/ScreenRunService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import type { HandoffEnded } from "./ServerBrowserScreen.ts";
import type { HandoffEnd } from "./SessionControl.ts";

/** Long enough to find the device and finish a sign-in; the wake tells the agent it expired. */
const REQUEST_MINUTES = 30;
/** Who settled it, when a person ended the hold on the screen rather than in the thread. */
const SCREEN: HandoffActor = { type: "client", label: "Agent screen" };

export const browserSessionId = (threadId: string, tabId: string) =>
  `browser:${encodeURIComponent(threadId)}:${encodeURIComponent(tabId)}`;
export const DESKTOP_SESSION_PREFIX = "desktop:";

type Target =
  | { readonly kind: "browser"; readonly tabId: string }
  | { readonly kind: "desktop"; readonly controlId: string; readonly expiresAt: DateTime.Utc };

interface Pending {
  readonly threadId: ThreadId;
  readonly handoffId: TurnItemId;
  readonly reason: string;
  readonly target: Target;
  /** The run that asked; a person's Stop of it ends the request. */
  readonly runId: RunId;
}

/** Run ends that mean a person stopped or put away the thread, unlike a turn that finished. */
const THREAD_ENDS: ReadonlySet<string> = new Set([
  "person_stop",
  "thread_archive",
  "thread_delete",
]);
/** How often open requests are checked against their stored records, events missed or not. */
const RECONCILE_EVERY = "15 seconds";

export class PreviewHandoffs extends Context.Service<
  PreviewHandoffs,
  {
    readonly request: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly reason: string;
      readonly tabId?: string;
    }) => Effect.Effect<PreviewRequestHandoffResult, OrchestratorMcpFailure>;
    /** The open request's reason for each desktop control that has one, by control id. */
    readonly desktopReasons: Effect.Effect<ReadonlyMap<string, string>>;
    /** A person handed a desktop control back. Stop and other ends are seen on the control. */
    readonly handBackDesktop: (controlId: string) => Effect.Effect<void>;
    /** A handoff record changed; one of these that ended frees its target. The watcher's step. */
    readonly recordEnded: (handoff: Handoff) => Effect.Effect<void>;
    /** Settles desktop requests whose control ended. Runs on every control change. */
    readonly reconcileDesktop: Effect.Effect<void>;
    /** One domain event: a record that ended, or a thread a person stopped or put away. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("goat/preview/PreviewHandoffs") {}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const make = Effect.gen(function* () {
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const browser = yield* Effect.serviceOption(ServerBrowser.ServerBrowser);
  const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const screen = yield* Effect.serviceOption(ScreenRunService.ScreenRunService);
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const scope = yield* Effect.scope;
  /** By preview session id. In memory, like the tabs and controls it holds. */
  const pending = new Map<string, Pending>();
  const keyOf = (threadId: string, target: Target) =>
    target.kind === "browser"
      ? browserSessionId(threadId, target.tabId)
      : `${DESKTOP_SESSION_PREFIX}${target.controlId}`;

  const hold = Effect.fn("PreviewHandoffs.hold")(function* (entry: Pending) {
    if (entry.target.kind === "browser")
      return Option.isSome(browser) && browser.value.requestHandoff
        ? yield* browser.value.requestHandoff({
            threadId: entry.threadId,
            tabId: entry.target.tabId,
            reason: entry.reason,
            requestId: entry.handoffId,
          })
        : false;
    if (Option.isNone(leases)) return false;
    const change = { threadId: entry.threadId, controlId: entry.target.controlId };
    yield* leases.value.hold(entry.target.controlId, true);
    // Cells already running on that control end now, as at a takeover.
    if (Option.isSome(screen)) {
      yield* screen.value.fence(change);
      yield* screen.value.controlChanged({ kind: "pause", ...change }).pipe(
        Effect.timeout("45 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("screen cut for a handoff failed", { cause }),
        ),
        Effect.forkDetach,
      );
    }
    return true;
  });

  /** The target side of an end: free the tab, or let the control act again. */
  const release = (entry: Pending) =>
    entry.target.kind === "browser"
      ? Option.isSome(browser) && browser.value.endHandoff
        ? browser.value.endHandoff({ threadId: entry.threadId, tabId: entry.target.tabId })
        : Effect.void
      : Option.isSome(leases)
        ? leases.value.hold(entry.target.controlId, false)
        : Effect.void;

  const transition = (
    input: { readonly threadId: ThreadId; readonly handoffId: TurnItemId },
    state: "completed" | "cancelled",
    actor: HandoffActor,
  ) =>
    threads
      .dispatch({
        type: "handoff.transition",
        // The id a thread answer with the same outcome uses, so the two never both apply.
        commandId: CommandId.make(`handoff:${input.handoffId}:${state}`),
        threadId: input.threadId,
        handoffId: input.handoffId,
        state,
        actor,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("a screen handoff end was not recorded", {
            handoffId: input.handoffId,
            cause,
          }),
        ),
      );

  /** The record side of an end a person made on the screen. */
  const settle = (entry: Pending, end: HandoffEnd) =>
    transition(entry, end === "handedBack" ? "completed" : "cancelled", SCREEN);

  const take = (key: string) =>
    Effect.sync(() => {
      const entry = pending.get(key);
      if (entry !== undefined) pending.delete(key);
      return entry;
    });

  const handBackDesktop = Effect.fn("PreviewHandoffs.handBackDesktop")(function* (
    controlId: string,
  ) {
    const entry = yield* take(`${DESKTOP_SESSION_PREFIX}${controlId}`);
    if (entry === undefined) return;
    yield* release(entry);
    yield* settle(entry, "handedBack");
  }, locked);

  const reconcileDesktop = Effect.gen(function* () {
    if (Option.isNone(leases)) return;
    const desktop = [...pending].filter(([, entry]) => entry.target.kind === "desktop");
    if (desktop.length === 0) return;
    const states = new Map(
      (yield* leases.value.sessions).map(({ control, state }) => [control.controlId, state]),
    );
    for (const [key, entry] of desktop) {
      if (entry.target.kind !== "desktop") continue;
      const state = states.get(entry.target.controlId);
      if (state !== undefined && state._tag !== "ended") continue;
      // Stopped, expired, replaced or turned off: nothing is held for the person any more. Only
      // a person's Stop is theirs; the agent is told the others ended without them.
      const stopped = state?.reason === "stopped" || state?.reason === "stopped_all";
      pending.delete(key);
      yield* release(entry);
      yield* transition(entry, "cancelled", stopped ? SCREEN : { type: "server" });
    }
  }).pipe(locked);

  const browserEnded = Effect.fn("PreviewHandoffs.browserEnded")(function* (ended: HandoffEnded) {
    const key = browserSessionId(ended.threadId, ended.tabId);
    const entry = pending.get(key);
    // A late end of an earlier request on this tab leaves the newer one alone.
    if (entry === undefined || entry.handoffId !== ended.requestId) return;
    pending.delete(key);
    yield* settle(entry, ended.end);
  }, locked);

  /**
   * A control expires without a signal, so each desktop request watches its control's deadline.
   * It starts at once, so its first wait is in place before the request returns.
   */
  const watchExpiry = Effect.fn("PreviewHandoffs.watchExpiry")(
    function* (entry: Pending, deadline: DateTime.Utc) {
      let until = deadline;
      while (Option.isSome(leases) && [...pending.values()].includes(entry)) {
        const left = DateTime.toEpochMillis(until) - DateTime.toEpochMillis(yield* DateTime.now);
        yield* Effect.sleep(Math.max(1000, left));
        yield* reconcileDesktop;
        const live = (yield* leases.value.sessions).find(
          ({ control }) =>
            entry.target.kind === "desktop" && control.controlId === entry.target.controlId,
        );
        if (live === undefined) return;
        until = live.control.expiresAt;
      }
    },
    Effect.forkIn(scope, { startImmediately: true }),
    Effect.asVoid,
  );

  const recordEnded = Effect.fn("PreviewHandoffs.recordEnded")(function* (handoff: Handoff) {
    if (handoff.target.path !== PREVIEW_HANDOFF_PATH || isHandoffPending(handoff.state)) return;
    for (const [key, entry] of pending)
      if (entry.handoffId === handoff.handoffId) {
        pending.delete(key);
        yield* release(entry);
      }
  }, locked);

  /**
   * Ends a request with its thread, as the agent would: no wake follows, since a person stopped
   * or put the thread away and waking it would start the turn they ended.
   */
  const endWithThread = Effect.fn("PreviewHandoffs.endWithThread")(function* (
    key: string,
    entry: Pending,
  ) {
    pending.delete(key);
    yield* release(entry);
    yield* transition(entry, "cancelled", { type: "agent", threadId: entry.threadId });
  });

  const threadEnded = Effect.fn("PreviewHandoffs.threadEnded")(function* (threadId: ThreadId) {
    for (const [key, entry] of pending)
      if (entry.threadId === threadId) yield* endWithThread(key, entry);
  }, locked);

  /** Checks every open request against what is stored, so a missed event delays it at most. */
  const reconcileRecords = Effect.gen(function* () {
    for (const [key, entry] of pending) {
      const record = yield* handoffs
        .read({ threadId: entry.threadId, handoffId: entry.handoffId })
        .pipe(Effect.option);
      if (Option.isNone(record)) continue;
      if (!isHandoffPending(record.value.state)) {
        pending.delete(key);
        yield* release(entry);
        continue;
      }
      const shell = yield* orchestrator.getThreadShell(entry.threadId).pipe(Effect.option);
      const records = yield* threads
        .getThreadRecords(entry.threadId, ["runs"], { runIds: [entry.runId] })
        .pipe(Effect.option);
      const cause = Option.isSome(records)
        ? records.value.runs.find((run) => run.id === entry.runId)?.terminationCause?.kind
        : undefined;
      const putAway =
        Option.isSome(shell) &&
        (shell.value === null || shell.value.archivedAt !== null || shell.value.deletedAt !== null);
      if (putAway || (cause !== undefined && THREAD_ENDS.has(cause)))
        yield* endWithThread(key, entry);
    }
  }).pipe(locked);

  const handle = (event: OrchestrationV2DomainEvent) =>
    event.type === "turn-item.updated" &&
    event.payload.type === "human_handoff" &&
    event.payload.handoff !== undefined
      ? recordEnded(event.payload.handoff)
      : (event.type === "run.updated" &&
            event.payload.terminationCause !== undefined &&
            THREAD_ENDS.has(event.payload.terminationCause.kind)) ||
          event.type === "thread.archived" ||
          event.type === "thread.deleted"
        ? threadEnded(event.threadId)
        : Effect.void;

  const resolveTarget = Effect.fn("PreviewHandoffs.resolveTarget")(function* (
    threadId: ThreadId,
    tabId: string | undefined,
  ) {
    if (tabId !== undefined) {
      if (Option.isNone(browser) || !browser.value.requestHandoff)
        return yield* invalid("This host has no server browser.");
      const tabs = yield* browser.value.sessions;
      const tab = tabs.find((view) => view.threadId === threadId && view.tabId === tabId);
      if (tab === undefined || tab.agentId === null)
        return yield* invalid(
          `This thread has no agent browser tab ${tabId}. Pass a tabId from goat_preview_status.`,
        );
      if (tab.agentStopped)
        return yield* invalid("A person stopped agent control of this tab; ask in the thread.");
      return {
        target: { kind: "browser", tabId } as Target,
        title: `Finish a step in ${tab.title.trim() || tab.url || "the agent's browser tab"}`,
        location: `The agent's browser tab ${tab.url} on this environment. Open it from the agent screens, take control, finish the step, then hand it back.`,
      };
    }
    const live = Option.isNone(leases)
      ? undefined
      : (yield* leases.value.sessions).find(
          ({ control, state }) => control.threadId === threadId && state._tag !== "ended",
        );
    if (live === undefined)
      return yield* invalid("This thread holds no computer use control. Pass tabId for a tab.");
    return {
      target: {
        kind: "desktop",
        controlId: live.control.controlId,
        expiresAt: live.control.expiresAt,
      } as Target,
      title: "Finish a step on this computer",
      location:
        "The computer this environment runs on. The asking agent is paused; finish the step, then hand it back from its agent screen card.",
    };
  });

  const request: PreviewHandoffs["Service"]["request"] = Effect.fn("PreviewHandoffs.request")(
    function* (input) {
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(Effect.mapError(() => invalid("The asking thread was not found.")));
      const run = ThreadManagement.latestActiveRun(records);
      const nodeId = run?.rootNodeId ?? null;
      if (run === undefined || nodeId === null)
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Ask from a running turn of this thread.",
        });
      const resolved = yield* resolveTarget(input.threadId, input.tabId);
      const key = keyOf(input.threadId, resolved.target);
      const expiresAt = DateTime.add(yield* DateTime.now, { minutes: REQUEST_MINUTES });
      const environmentId = yield* environment.getEnvironmentId;
      // Created under the lock, so no record end or restart sweep sees it before its hold.
      const handoff = yield* Effect.gen(function* () {
        const created = yield* handoffs
          .create({
            kind: "mfa",
            title: resolved.title,
            reason: input.reason,
            requestedBy: {
              threadId: input.threadId,
              providerInstanceId: input.providerInstanceId,
              path: "preview.request_handoff",
            },
            target: { environmentId, path: PREVIEW_HANDOFF_PATH },
            runId: run.id,
            nodeId,
            human: { location: resolved.location },
            // The dedupe key: one open request per tab or control.
            args: { session: key },
            expiresAt,
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "limit_reached"
                ? invalid("This thread already has three open requests for a person.")
                : new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
            ),
          );
        const entry: Pending = {
          threadId: input.threadId,
          handoffId: TurnItemId.make(created.handoffId),
          reason: input.reason,
          target: resolved.target,
          runId: run.id,
        };
        const existing = pending.get(key);
        // Asked again while it waits: the hold stands, and an end already queued settles it.
        if (existing?.handoffId === entry.handoffId) return created;
        // An earlier request whose end is still queued: its hold gives way to this one.
        if (existing !== undefined) yield* release(existing);
        pending.set(key, entry);
        if (yield* hold(entry)) {
          if (entry.target.kind === "desktop") yield* watchExpiry(entry, entry.target.expiresAt);
          return created;
        }
        pending.delete(key);
        // The tab closed or a person stopped it in between: nothing is waiting.
        yield* settle(entry, "ended");
        return undefined;
      }).pipe(locked);
      if (handoff === undefined)
        return yield* invalid("That tab closed or was stopped before a person could be asked.");
      const until = DateTime.formatIso(handoff.expiresAt ?? expiresAt);
      return {
        kind: "needs_human",
        handoff,
        next: {
          after: "terminal",
          call: resolved.target.kind === "browser" ? "preview_snapshot" : "goat_screen_run",
        },
        message: `A person was asked: ${input.reason} Do not act on this ${resolved.target.kind === "browser" ? "tab" : "screen"} until they hand it back; your input there is refused meanwhile. End this turn now. GOAT wakes this thread when they hand it back, decline, or the request expires at ${until}. Then observe again before acting.`,
      } satisfies PreviewRequestHandoffResult;
    },
  );

  /** A restart dropped every hold; the requests it left would otherwise wait for nothing. */
  const cancelOrphans = Effect.gen(function* () {
    const rows = yield* sql<{ readonly thread_id: string; readonly turn_item_id: string }>`
      SELECT thread_id, turn_item_id FROM orchestration_v2_projection_turn_items
      WHERE type = 'human_handoff' AND status = 'waiting'
        AND json_extract(payload_json, '$.handoff.target.path') = ${PREVIEW_HANDOFF_PATH}`;
    for (const row of rows) {
      const handoffId = TurnItemId.make(row.turn_item_id);
      if ([...pending.values()].some((entry) => entry.handoffId === handoffId)) continue;
      yield* transition({ threadId: ThreadId.make(row.thread_id), handoffId }, "cancelled", {
        type: "server",
      });
    }
  }).pipe(
    locked,
    Effect.catchCause((cause) => Effect.logWarning("orphaned screen handoffs remain", { cause })),
  );

  if (Option.isSome(browser) && browser.value.onHandoffEnd) {
    const ends = yield* Queue.unbounded<HandoffEnded>();
    const unsubscribe = browser.value.onHandoffEnd((ended) => void Queue.offerUnsafe(ends, ended));
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    yield* Queue.take(ends).pipe(Effect.flatMap(browserEnded), Effect.forever, Effect.forkScoped);
  }
  if (Option.isSome(leases)) {
    const changes = yield* leases.value.subscribe;
    yield* PubSub.take(changes).pipe(
      Effect.andThen(reconcileDesktop),
      Effect.forever,
      Effect.forkScoped,
    );
  }
  // The live stream starts at the latest event and may fail; each (re)subscribe is followed by a
  // check of the stored records, and the timer repeats that check, so no end is lost for good.
  const watch = orchestrator.streamDomainEvents.pipe(
    Stream.runForEach(handle),
    Effect.catchCause((cause) => Effect.logWarning("screen handoff watch restarts", { cause })),
    Effect.andThen(Effect.sleep("5 seconds")),
  );
  yield* forkParked(
    cancelOrphans.pipe(
      Effect.andThen(
        Effect.forever(
          Effect.all([watch, Effect.sleep("1 second").pipe(Effect.andThen(reconcileRecords))], {
            concurrency: "unbounded",
          }),
        ),
      ),
    ),
  );
  yield* Effect.sleep(RECONCILE_EVERY).pipe(
    Effect.andThen(reconcileRecords),
    Effect.forever,
    Effect.forkIn(scope, { startImmediately: true }),
  );

  return PreviewHandoffs.of({
    request,
    desktopReasons: Effect.sync(() => {
      const reasons = new Map<string, string>();
      for (const entry of pending.values())
        if (entry.target.kind === "desktop") reasons.set(entry.target.controlId, entry.reason);
      return reasons;
    }),
    handBackDesktop,
    recordEnded,
    handle,
    reconcileDesktop,
  });
});

export const layer = Layer.effect(PreviewHandoffs, make);
