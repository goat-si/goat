import { ProviderTurnId, type OrchestrationV2ProviderThread } from "@goat/contracts";
import type * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderAdapterProtocolError } from "@goat/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import type * as Acp from "effect-acp/compat";
import type { CloudRelay } from "./relay.ts";
import { DRIVER } from "./capabilities.ts";

const MAX_SUMMARY = 64_000;
const MAX_PROGRESS = 2_000;
const MAX_EARLY_SESSIONS = 8;
const MAX_MESSAGES = 64;
export type TaskInput = Pick<
  Adapter.ProviderAdapterV2TurnInput,
  | "threadId"
  | "runId"
  | "runOrdinal"
  | "attemptId"
  | "rootNodeId"
  | "providerThread"
  | "providerTurnOrdinal"
  | "commitCloudTask"
  | "commitCloudTaskMetadata"
>;

export function matchingPr(text: string, repository: string): string | undefined {
  let repo: URL;
  try {
    repo = new URL(repository);
  } catch {
    return undefined;
  }
  if (
    repo.protocol !== "https:" ||
    repo.hostname !== "github.com" ||
    repo.port ||
    repo.username ||
    repo.password ||
    repo.search ||
    repo.hash
  )
    return undefined;
  const expected = repo.pathname
    .replace(/\/$/u, "")
    .replace(/\.git$/u, "")
    .toLowerCase();
  for (const raw of text.match(/https:\/\/github\.com\/[^\s<>]+/gu) ?? []) {
    try {
      const link = new URL(raw.replace(/[),.;]+$/u, ""));
      const match = /^(\/[^/]+\/[^/]+)\/pull\/(\d+)\/?$/u.exec(link.pathname);
      if (
        link.protocol === "https:" &&
        link.hostname === "github.com" &&
        match?.[1]?.toLowerCase() === expected &&
        !link.username &&
        !link.password &&
        !link.port &&
        !link.search &&
        !link.hash
      ) {
        return `https://github.com${match[1]}/pull/${match[2]}`;
      }
    } catch {
      /* Ignore response links that are not parseable PR URLs. */
    }
  }
  return undefined;
}

export function sourcePrompt(
  thread: OrchestrationV2ProviderThread,
  text: string,
  needsInitialSourceInstructions: boolean,
): string {
  const source = thread.cloudTask?.source;
  if (!source?.repository || !source.branch || !source.sha) return "";
  const instructions = needsInitialSourceInstructions
    ? `Use only the pushed repository ${source.repository}, branch ${source.branch}, commit ${source.sha}.\n` +
      "Verify the checkout at that commit in your cloud VM before editing. Local changes are not included. " +
      "If access or checkout fails, report the block and do not substitute another repository or revision."
    : "Continue this same cloud session and its existing output work; do not reset to the input revision.";
  return `${instructions}\nReturn a summary and a PR URL for the actual output when available.\n\n${text}`;
}

type SessionMetadata = Adapter.ProviderAdapterV2CloudTaskMetadata;
const bounded = (value: unknown, size: number) =>
  typeof value === "string" ? value.slice(0, size) : undefined;

/** Captured namespaced fields only; session activity is not a prompt terminal. */
export function sessionMetadata(meta: unknown, title?: unknown): SessionMetadata {
  const outer = Predicate.isObject(meta) ? meta : undefined;
  const nested = outer?.["cognition.ai/session"];
  const session = Predicate.isObject(nested) ? nested : undefined;
  const rawUrl = session?.["cognition.ai/url"];
  let url: string | undefined;
  if (typeof rawUrl === "string" && rawUrl.length <= 2048) {
    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.origin === "https://app.devin.ai" &&
        !parsed.username &&
        !parsed.password &&
        /^\/sessions\/[^/]+$/u.test(parsed.pathname) &&
        !parsed.search &&
        !parsed.hash
      )
        url = parsed.href;
    } catch {
      /* Unsupported links cannot become an Open-session destination. */
    }
  }
  const status = outer?.["cognition.ai/statusEnum"] ?? session?.["cognition.ai/statusEnum"];
  const detail = bounded(
    outer?.["cognition.ai/statusMessage"] ??
      session?.["cognition.ai/statusMessage"] ??
      session?.["cognition.ai/userActionRequired"] ??
      session?.["cognition.ai/currentActivity"],
    MAX_PROGRESS,
  );
  const progress =
    status === "blocked"
      ? `Waiting for input${detail ? `: ${detail}` : "."}`.slice(0, MAX_PROGRESS)
      : status === "working"
        ? (detail ?? "Working in Devin Cloud.")
        : detail;
  const name = bounded(title, 512);
  return {
    ...(url ? { url } : {}),
    ...(name ? { title: name } : {}),
    ...(progress ? { progress } : {}),
  };
}

/** One observer per runtime. The same gate owns bind, progress, settlement and Stop dispatch. */
export const makeTaskObserver = Effect.fn("DevinCloud.makeTaskObserver")(function* (
  emit: (event: Adapter.ProviderAdapterV2Event) => Effect.Effect<void>,
  onUncertain: (reason: string) => Effect.Effect<void>,
  onSettled: () => Effect.Effect<void> = () => Effect.void,
) {
  const gate = yield* Semaphore.make(1);
  let input: TaskInput | undefined;
  let thread: OrchestrationV2ProviderThread | undefined;
  let text = "";
  const messages = new Map<string, string>();
  let lastProgress = "";
  let unpublishedChars = 0;
  let accessBlocked = false;
  let startedAt: DateTime.Utc | null = null;
  let settled = true;
  let replaying = false;
  let promptDispatched = false;
  let stopRequested = false;
  let closed = false;
  const early = new Map<string, SessionMetadata>();
  const turnId = () =>
    ProviderTurnId.make(
      `devin-cloud:${encodeURIComponent(thread!.providerInstanceId)}:${input!.runId}:${input!.attemptId}:${input!.providerTurnOrdinal}`,
    );
  const updateTask = Effect.fn("DevinCloud.updateTask")(function* (
    patch: Partial<NonNullable<OrchestrationV2ProviderThread["cloudTask"]>>,
  ) {
    if (!thread?.cloudTask || closed) return;
    const currentTask = thread.cloudTask;
    if (Object.entries(patch).every(([key, value]) => Reflect.get(currentTask, key) === value))
      return;
    const now = yield* DateTime.now;
    thread = {
      ...thread,
      cloudTask: { ...currentTask, ...patch, updatedAt: DateTime.formatIso(now) },
      updatedAt: now,
    };
    yield* emit({ type: "provider_thread.updated", driver: DRIVER, providerThread: thread });
  });
  const finish = Effect.fn("DevinCloud.finish")(function* (reason: Acp.StopReason) {
    if (!input || !thread?.cloudTask || settled || closed) return;
    const ref = thread.nativeThreadRef;
    if (!input.commitCloudTask || ref?.ordinal === undefined) {
      return yield* new ProviderAdapterProtocolError({
        driver: DRIVER,
        detail: "Cloud response has no acknowledged prompt-count persistence port",
      });
    }
    const cancelled = reason === "cancelled";
    const failed = !cancelled && (reason !== "end_turn" || accessBlocked);
    const prUrl = matchingPr(text, thread.cloudTask.source.repository);
    const summary = text || "Devin ended this response without returning summary text.";
    const { error: _error, prUrl: _prUrl, branch: _branch, ...confirmedTask } = thread.cloudTask;
    const now = yield* DateTime.now;
    const task = {
      ...confirmedTask,
      status: cancelled
        ? ("cancelled" as const)
        : failed
          ? ("failed" as const)
          : ("succeeded" as const),
      summary,
      ...(prUrl ? { prUrl } : {}),
      progress: accessBlocked
        ? "Response complete; repository access is blocked."
        : (confirmedTask.progress ?? "Response complete."),
      updatedAt: DateTime.formatIso(now),
    };
    const nextRef = { ...ref, ordinal: ref.ordinal + 1 };
    // Correlated response advances the durable marker exactly once, before any terminal.
    yield* input.commitCloudTask(task, {
      nativeThreadRef: nextRef,
      nativeConversationHeadRef: thread.nativeConversationHeadRef,
    });
    settled = true;
    thread = {
      ...thread,
      cloudTask: task,
      nativeThreadRef: nextRef,
      status: "idle",
      updatedAt: now,
    };
    yield* emit({ type: "provider_thread.updated", driver: DRIVER, providerThread: thread });
    yield* emit({
      type: "provider_turn.updated",
      driver: DRIVER,
      threadId: input.threadId,
      providerTurn: {
        id: turnId(),
        providerThreadId: thread.id,
        nodeId: input.rootNodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: null,
        ordinal: input.providerTurnOrdinal,
        status: cancelled
          ? stopRequested
            ? "interrupted"
            : "cancelled"
          : failed
            ? "failed"
            : "completed",
        startedAt,
        completedAt: now,
      },
    });
    yield* onSettled();
    // The base creates the sole ordinary result in its terminal transaction.
    if (failed) {
      yield* emit({
        type: "turn.terminal",
        driver: DRIVER,
        providerThreadId: thread.id,
        providerTurnId: turnId(),
        runOrdinal: input.runOrdinal,
        failureItemOrdinal: 1,
        status: "failed",
        failure: makeProviderFailure({
          class: "provider_error",
          message: accessBlocked
            ? "Devin could not access the published repository."
            : "Devin did not complete this response.",
          code: accessBlocked ? "repository_access_blocked" : reason,
        }),
        threadDisposition: "reusable",
      });
    } else {
      yield* emit({
        type: "turn.terminal",
        driver: DRIVER,
        providerThreadId: thread.id,
        providerTurnId: turnId(),
        runOrdinal: input.runOrdinal,
        status: cancelled ? (stopRequested ? "interrupted" : "cancelled") : "completed",
        failure: null,
        threadDisposition: "reusable",
      });
    }
  });
  const update = (notice: Acp.SessionNotification) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (closed) return;
        const item = notice.update;
        const metadata = {
          ...sessionMetadata(notice._meta),
          ...sessionMetadata(
            "_meta" in item ? item._meta : undefined,
            item.sessionUpdate === "session_info_update" ? item.title : undefined,
          ),
        };
        if (!input || !thread) {
          if (!Object.keys(metadata).length) return;
          early.set(notice.sessionId, { ...early.get(notice.sessionId), ...metadata });
          while (early.size > MAX_EARLY_SESSIONS) early.delete(early.keys().next().value!);
          return;
        }
        if (notice.sessionId !== thread.nativeThreadRef?.nativeId) return;
        if (settled) {
          const task = thread.cloudTask;
          const patch = Object.fromEntries(
            Object.entries(metadata).filter(
              ([key, value]) => !task || Reflect.get(task, key) !== value,
            ),
          );
          if (Object.keys(patch).length && input.commitCloudTaskMetadata) {
            // No stale full-thread event after terminal; the base checks native/run ownership.
            yield* input.commitCloudTaskMetadata(notice.sessionId, patch).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (thread?.cloudTask)
                    thread = { ...thread, cloudTask: { ...thread.cloudTask, ...patch } };
                }),
              ),
              Effect.catch(() =>
                Effect.logWarning("Devin cloud metadata could not be persisted", {
                  runId: input!.runId,
                  providerThreadId: thread!.id,
                }),
              ),
            );
          }
          return;
        }
        if (Object.keys(metadata).length) yield* updateTask(metadata);
        if (replaying || !promptDispatched) return;
        if (
          (item.sessionUpdate === "agent_message_chunk" && item.content.type === "text") ||
          item.sessionUpdate === "agent_message"
        ) {
          const id = item.messageId ?? "response";
          const content =
            item.sessionUpdate === "agent_message"
              ? (item.content ?? [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")
              : item.content.type === "text"
                ? item.content.text
                : "";
          messages.set(
            id,
            (item.sessionUpdate === "agent_message"
              ? content
              : (messages.get(id) ?? "") + content
            ).slice(-MAX_SUMMARY),
          );
          while (messages.size > MAX_MESSAGES) messages.delete(messages.keys().next().value!);
          text = Array.from(messages.values()).join("\n").slice(-MAX_SUMMARY);
          accessBlocked ||= text.includes("Blocked: no repos are cloned here,");
          const progress = text.slice(-MAX_PROGRESS);
          unpublishedChars = Math.min(MAX_SUMMARY, unpublishedChars + content.length);
          if (progress !== lastProgress && (unpublishedChars >= 512 || content.includes("\n"))) {
            lastProgress = progress;
            unpublishedChars = 0;
            yield* updateTask({ status: "running", progress });
          }
        } else if (
          item.sessionUpdate === "tool_call" &&
          item.title.slice(0, MAX_PROGRESS) !== lastProgress
        ) {
          lastProgress = item.title.slice(0, MAX_PROGRESS);
          yield* updateTask({ status: "running", progress: lastProgress });
        }
      }),
    );
  const uncertain = (detail: string, expected: TaskInput | undefined) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (settled || closed || input !== expected) return;
        const summary = text || thread?.cloudTask?.summary;
        yield* updateTask({
          status: "unknown",
          ...(summary !== undefined ? { summary } : {}),
          error: detail,
        });
        settled = true;
        yield* onUncertain(detail);
        if (input && thread)
          yield* emit({
            type: "turn.terminal",
            driver: DRIVER,
            providerThreadId: thread.id,
            providerTurnId: turnId(),
            runOrdinal: input.runOrdinal,
            failureItemOrdinal: 1,
            status: "failed",
            threadDisposition: "broken",
            failure: makeProviderFailure({
              class: "provider_error",
              message: detail,
              code: "cloud_observation_unknown",
            }),
          });
      }),
    );
  const bind = (next: TaskInput, recovered: boolean) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (closed || !settled)
          return yield* new ProviderAdapterProtocolError({
            driver: DRIVER,
            detail: "A cloud turn is already attached to this runtime",
          });
        input = next;
        thread = next.providerThread;
        text = recovered ? (thread.cloudTask?.summary ?? "") : "";
        messages.clear();
        lastProgress = "";
        unpublishedChars = 0;
        accessBlocked = false;
        if (!recovered && thread.cloudTask) {
          const {
            summary: _summary,
            prUrl: _prUrl,
            branch: _branch,
            error: _error,
            ...freshTask
          } = thread.cloudTask;
          thread = { ...thread, cloudTask: freshTask };
        }
        settled = false;
        stopRequested = false;
        promptDispatched = false;
        replaying = recovered;
        const retained = early.get(thread.nativeThreadRef?.nativeId ?? "");
        early.clear();
        if (retained) yield* updateTask(retained);
        const now = yield* DateTime.now;
        startedAt = now;
        yield* emit({
          type: "provider_turn.updated",
          driver: DRIVER,
          threadId: next.threadId,
          providerTurn: {
            id: turnId(),
            providerThreadId: thread.id,
            nodeId: next.rootNodeId,
            runAttemptId: next.attemptId,
            nativeTurnRef: null,
            ordinal: next.providerTurnOrdinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
      }),
    );
  return {
    update,
    bind,
    assertIdle: gate.withPermit(
      Effect.gen(function* () {
        if (closed || !settled)
          return yield* new ProviderAdapterProtocolError({
            driver: DRIVER,
            detail: "A cloud turn is already attached to this runtime",
          });
      }),
    ),
    close: gate.withPermit(
      Effect.sync(() => {
        closed = true;
        early.clear();
        messages.clear();
      }),
    ),
    rejectSource: (detail: string) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (closed || settled) return;
          settled = true;
          yield* updateTask({
            status: "failed",
            error: detail,
            summary: `Repository configuration failed before any prompt was sent: ${detail}`,
            progress: detail.slice(0, MAX_PROGRESS),
          });
          // startTurn fails next, and the base stops ingesting before this thread's event lands.
          // Without a durable commit it would finalize the stale running task as unknown.
          const turn = input;
          const rejected = thread;
          if (turn?.commitCloudTask && rejected?.cloudTask) {
            yield* turn
              .commitCloudTask(rejected.cloudTask, {
                nativeThreadRef: rejected.nativeThreadRef,
                nativeConversationHeadRef: rejected.nativeConversationHeadRef,
              })
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("Devin cloud source rejection could not be persisted", {
                    runId: turn.runId,
                    providerThreadId: rejected.id,
                  }),
                ),
              );
          }
          yield* onUncertain(detail);
          // startTurn returns the error; base owns its start-failure terminal.
        }),
      ),
    run: Effect.fn("DevinCloud.observePrompt")(function* (relay: CloudRelay, prompt: string) {
      const bound = input;
      const id = yield* gate.withPermit(
        Effect.gen(function* () {
          if (
            !bound ||
            input !== bound ||
            !thread?.nativeThreadRef?.nativeId ||
            settled ||
            closed ||
            promptDispatched ||
            replaying
          )
            return undefined;
          promptDispatched = true;
          yield* updateTask({ status: "running", taskId: thread.nativeThreadRef.nativeId });
          return thread.nativeThreadRef.nativeId;
        }),
      );
      if (!id) return;
      yield* Effect.gen(function* () {
        const result = yield* relay.prompt(id, prompt);
        yield* gate.withPermit(
          Effect.gen(function* () {
            if (input !== bound || settled || closed) return;
            yield* updateTask(sessionMetadata(result._meta));
            yield* finish(result.stopReason);
          }),
        );
      }).pipe(
        Effect.catch(() =>
          uncertain(
            "Could not confirm the cloud prompt outcome; no automatic resubmission.",
            bound,
          ),
        ),
      );
    }),
    attach: Effect.fn("DevinCloud.observeSavedSession")(function* (relay: CloudRelay) {
      const bound = input;
      const id = thread?.nativeThreadRef?.nativeId;
      if (!id || closed || settled) return;
      yield* Effect.gen(function* () {
        const result = yield* relay.attach(id);
        yield* gate.withPermit(
          Effect.gen(function* () {
            if (input !== bound || closed || settled) return;
            yield* updateTask(sessionMetadata(result._meta));
          }),
        );
        yield* uncertain(
          "Session loaded, but its status does not identify this GOAT prompt's outcome. Review the saved session; no prompt was resent.",
          bound,
        );
      }).pipe(
        Effect.catch(() =>
          uncertain("This cloud session could not be loaded. No prompt was resent.", bound),
        ),
      );
    }),
    cancel: (relay: CloudRelay, requestedProviderTurnId: ProviderTurnId) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (
            closed ||
            settled ||
            replaying ||
            !promptDispatched ||
            !thread?.nativeThreadRef?.nativeId ||
            !input ||
            requestedProviderTurnId !== turnId() ||
            stopRequested
          )
            return;
          stopRequested = true;
          yield* updateTask({ progress: "Cancellation requested; awaiting confirmation." });
          // Dispatch stays under the identity gate. Its ACK cannot settle a prompt.
          yield* relay.cancel(thread.nativeThreadRef.nativeId);
        }),
      ),
  };
});
