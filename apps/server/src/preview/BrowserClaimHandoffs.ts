import {
  BROWSER_CLAIM_ANSWER_HANDOFF_PATH,
  OrchestratorMcpFailure,
  HandoffError,
  TurnItemId,
  ThreadId,
  isHandoffPending,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { BrowserOriginGrants } from "./BrowserOriginGrantsLayer.ts";
import type { makeBrowserOriginGrants } from "./BrowserOriginGrants.ts";

type Grants = Effect.Success<ReturnType<typeof makeBrowserOriginGrants>>;
type Entry = { readonly threadId: ThreadId; readonly handoffId: TurnItemId };
type Request = {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly pid: number;
  readonly windowId: number;
  readonly origin: string;
};
const failure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not create the browser claim approval.",
  });

export const makeBrowserClaimHandoffs = Effect.fn("BrowserClaimHandoffs.make")(function* (deps: {
  grants: Grants;
  handoffs: Handoffs.Handoffs["Service"];
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadRecords">;
  environmentId: EnvironmentId;
  events: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
}) {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const entries = new Map<string, Entry>();
  let healthy = true;
  const scope = yield* Effect.scope;
  while (true) {
    const orphans = yield* sql<{
      thread_id: string;
      turn_item_id: string;
    }>`SELECT thread_id, turn_item_id
      FROM orchestration_v2_projection_turn_items
      WHERE type = 'human_handoff' AND status = 'waiting'
        AND json_extract(payload_json, '$.handoff.target.path') = ${BROWSER_CLAIM_ANSWER_HANDOFF_PATH}
      LIMIT 256`;
    if (orphans.length === 0) break;
    for (const orphan of orphans) {
      const ended = yield* deps.handoffs.endBrowserClaim(
        {
          threadId: ThreadId.make(orphan.thread_id),
          handoffId: TurnItemId.make(orphan.turn_item_id),
        },
        "cancelled",
        "The browser claim ended when the server restarted.",
      );
      if (isHandoffPending(ended.state))
        return yield* new HandoffError({
          reason: "unavailable",
          detail: "Could not cancel an orphaned browser claim card.",
        });
    }
  }
  const reconcileClaims = Effect.fn("BrowserClaimHandoffs.reconcileClaims")(function* () {
    const pending = new Set((yield* deps.grants.listAll()).pending.map((entry) => entry.claimId));
    for (const [claimId, entry] of entries) {
      if (pending.has(claimId)) continue;
      const why = yield* deps.grants.endReason(entry.threadId, claimId);
      const reason =
        why === "blocked_url"
          ? "The site is blocked."
          : why === "driver_restarted"
            ? "The browser driver restarted."
            : why === "stopped"
              ? "Computer use stopped."
              : "The browser claim ended.";
      yield* deps.handoffs.endBrowserClaim(entry, "cancelled", reason);
      entries.delete(claimId);
    }
  }, lock.withPermits(1));
  const recordEnded = Effect.fn("BrowserClaimHandoffs.recordEnded")(function* (
    handoff: import("@goat/contracts").Handoff,
  ) {
    if (
      handoff.target.path !== BROWSER_CLAIM_ANSWER_HANDOFF_PATH ||
      isHandoffPending(handoff.state)
    )
      return;
    for (const [claimId, entry] of entries) {
      if (entry.handoffId !== handoff.handoffId) continue;
      if (handoff.state !== "completed") yield* deps.grants.answer(claimId, false);
      entries.delete(claimId);
    }
  }, lock.withPermits(1));
  const watchFailed = Effect.fn("BrowserClaimHandoffs.watchFailed")(function* (cause: unknown) {
    healthy = false;
    yield* Effect.logError("Browser claim handoff watcher failed", { cause });
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        for (const [claimId, entry] of entries) {
          const declined = yield* deps.grants.answer(claimId, false).pipe(Effect.result);
          if (declined._tag === "Failure")
            yield* Effect.logError("Could not decline browser claim", {
              claimId,
              error: declined.failure,
            });
          const ended = yield* deps.handoffs
            .endBrowserClaim(entry, "cancelled", "The approval service stopped.")
            .pipe(Effect.result);
          if (ended._tag === "Failure")
            yield* Effect.logError("Could not cancel browser claim card", {
              claimId,
              error: ended.failure,
            });
          if (declined._tag === "Success" && ended._tag === "Success") entries.delete(claimId);
        }
      }),
    );
  });
  yield* deps.grants.changes.pipe(
    Stream.runForEach(() => reconcileClaims()),
    Effect.andThen(watchFailed("Browser claim change stream ended.")),
    Effect.catch(watchFailed),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* deps.events.pipe(
    Stream.runForEach((event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "human_handoff" &&
      event.payload.handoff
        ? recordEnded(event.payload.handoff)
        : Effect.void,
    ),
    Effect.andThen(watchFailed("Handoff event stream ended.")),
    Effect.catch(watchFailed),
    Effect.forkScoped({ startImmediately: true }),
  );
  const request = Effect.fn("BrowserClaimHandoffs.request")((input: Request) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!healthy || entries.size >= 1024) return yield* failure();
        const result = yield* deps.grants.requestWindow(input).pipe(Effect.mapError(failure));
        if (result.status !== "pending") return result;
        const claimId = result.claimId;
        const create = Effect.gen(function* () {
          const pending = (yield* deps.grants.listAll()).pending.find(
            (entry) => entry.claimId === claimId,
          );
          if (!pending) return yield* failure();
          const records = yield* deps.threads
            .getThreadRecords(input.threadId, ["runs"])
            .pipe(Effect.mapError(failure));
          const run = ThreadManagement.latestActiveRun(records);
          if (!run || !run.rootNodeId) return yield* failure();
          const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 15 });
          const card = yield* deps.handoffs
            .create({
              kind: "approval",
              title: "Let this thread use a browser tab",
              reason: `Use ${pending.windowTitle} at ${pending.origin}. The agent can already see this window title and origin.`,
              requestedBy: {
                threadId: input.threadId,
                providerInstanceId: input.providerInstanceId,
                path: "browser_claim.request",
              },
              target: {
                environmentId: deps.environmentId,
                path: BROWSER_CLAIM_ANSWER_HANDOFF_PATH,
              },
              runId: run.id,
              nodeId: run.rootNodeId,
              human: { location: "Browser tab" },
              args: { claimId },
              expiresAt,
            })
            .pipe(Effect.mapError(failure));
          const entry = { threadId: input.threadId, handoffId: TurnItemId.make(card.handoffId) };
          entries.set(claimId, entry);
          if (!(yield* deps.grants.listAll()).pending.some((value) => value.claimId === claimId)) {
            yield* deps.handoffs
              .endBrowserClaim(entry, "cancelled", "The browser claim ended.")
              .pipe(Effect.mapError(failure));
            entries.delete(claimId);
            return (yield* deps.grants.answer(claimId, false).pipe(Effect.mapError(failure)))
              .agentResult;
          } else {
            const remaining = Math.max(
              0,
              DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(yield* DateTime.now),
            );
            yield* Effect.sleep(remaining).pipe(
              Effect.andThen(
                lock.withPermits(1)(
                  Effect.gen(function* () {
                    if (entries.get(claimId) !== entry) return;
                    const ended = yield* deps.handoffs.endBrowserClaim(
                      entry,
                      "expired",
                      "The request expired.",
                    );
                    if (ended.state !== "completed") yield* deps.grants.answer(claimId, false);
                    entries.delete(claimId);
                  }),
                ),
              ),
              Effect.catch(watchFailed),
              Effect.forkIn(scope, { startImmediately: true }),
            );
          }
          return result;
        });
        return yield* create.pipe(
          Effect.catch((error) =>
            deps.grants
              .answer(claimId, false)
              .pipe(Effect.mapError(failure), Effect.andThen(Effect.fail(error))),
          ),
        );
      }),
    ),
  );
  return { request };
});

export class BrowserClaimHandoffs extends Context.Service<
  BrowserClaimHandoffs,
  Effect.Success<ReturnType<typeof makeBrowserClaimHandoffs>>
>()("goat/preview/BrowserClaimHandoffs") {}
export const layer = Layer.effect(
  BrowserClaimHandoffs,
  Effect.gen(function* () {
    const grants = yield* BrowserOriginGrants;
    const handoffs = yield* Handoffs.Handoffs;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* makeBrowserClaimHandoffs({
      grants,
      handoffs,
      threads,
      environmentId: yield* environment.getEnvironmentId,
      events: orchestrator.streamDomainEvents,
    });
  }),
);
