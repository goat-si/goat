import {
  type ProviderInstanceId,
  type OrchestrationV2ProviderThread,
  type ProviderOptionSelection,
} from "@goat/contracts";
import * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Cli from "./cli.ts";
import * as Relay from "./relay.ts";
import { CAPABILITIES, DRIVER } from "./capabilities.ts";
import { makeTaskObserver, sessionMetadata, sourcePrompt } from "./task.ts";
import { DEVIN_MODELS } from "../settings.ts";

/** Same option values by id, regardless of the order a client sent them in. */
const sameOptions = (
  left: ReadonlyArray<ProviderOptionSelection> | undefined,
  right: ReadonlyArray<ProviderOptionSelection> | undefined,
) => {
  const values = (options: ReadonlyArray<ProviderOptionSelection> | undefined) =>
    new Map((options ?? []).map((option) => [option.id, option.value]));
  const a = values(left);
  const b = values(right);
  return a.size === b.size && [...a].every(([id, value]) => b.get(id) === value);
};

export const makeAdapter = Effect.fn("DevinCloud.makeAdapter")(function* (
  instanceId: ProviderInstanceId,
  siblingId: string,
) {
  const cli = yield* Cli.DevinCloudCli;
  const relays = yield* Relay.DevinCloudRelay;
  return Adapter.ProviderAdapterV2.of({
    instanceId,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(CAPABILITIES),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.model === target.model && sameOptions(current.options, target.options)
          ? { type: "apply_on_next_turn" as const }
          : {
              type: "reject" as const,
              reason: "Changing the Devin Cloud model requires a new thread.",
            },
      ),
    openSession: Effect.fn("DevinCloud.openSession")(function* (
      opened: Adapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const fail = (detail: string, cause?: unknown) =>
        new Adapter.ProviderAdapterProtocolError({
          driver: DRIVER,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const cwd = opened.runtimePolicy.cwd;
      const model = opened.modelSelection.model;
      const options = opened.modelSelection.options ?? [];
      const platformChoices = ["default", "linux", "macos", "windows"];
      const platform = options.find((option) => option.id === "platform")?.value ?? "default";
      if (!cwd || !DEVIN_MODELS.some(([slug]) => slug === model))
        return yield* fail("Select a project and a supported Devin Cloud model");
      if (
        options.some((option) => option.id !== "platform") ||
        options.filter((option) => option.id === "platform").length > 1 ||
        typeof platform !== "string" ||
        !platformChoices.includes(platform)
      )
        return yield* fail("Select a supported Devin Cloud platform");
      if (
        opened.runtimePolicy.runtimeMode !== "full-access" ||
        opened.runtimePolicy.interactionMode !== "default"
      ) {
        return yield* fail("Devin Cloud requires Full access and Build");
      }
      const launch = yield* cli.resolve(siblingId, cwd).pipe(
        Effect.mapError(
          (cause) =>
            new Adapter.ProviderAdapterOpenSessionError({
              driver: DRIVER,
              providerSessionId: opened.providerSessionId,
              cause,
            }),
        ),
      );
      yield* cli.probe(launch).pipe(
        Effect.mapError(
          (cause) =>
            new Adapter.ProviderAdapterOpenSessionError({
              driver: DRIVER,
              providerSessionId: opened.providerSessionId,
              cause,
            }),
        ),
      );
      const scope = yield* Effect.scope;
      const queue = yield* Effect.acquireRelease(
        Queue.unbounded<Adapter.ProviderAdapterV2Event>(),
        Queue.shutdown,
      );
      let current: OrchestrationV2ProviderThread | undefined;
      const emit = (event: Adapter.ProviderAdapterV2Event) =>
        Effect.gen(function* () {
          if (event.type === "provider_thread.updated") current = event.providerThread;
          yield* Queue.offer(queue, event);
        });
      const now = yield* DateTime.now;
      let session = {
        id: opened.providerSessionId,
        driver: DRIVER,
        providerInstanceId: instanceId,
        status: "ready" as "ready" | "error",
        cwd,
        model,
        capabilities: CAPABILITIES,
        createdAt: now,
        updatedAt: now,
        lastError: null as string | null,
      };
      const uncertain = Effect.fn("DevinCloud.uncertain")(function* (reason: string) {
        session = {
          ...session,
          status: "error",
          lastError: reason,
          capabilities: {
            ...CAPABILITIES,
            sessions: { ...CAPABILITIES.sessions, followUp: { supported: false, reason } },
          },
          updatedAt: yield* DateTime.now,
        };
        yield* emit({ type: "provider_session.updated", driver: DRIVER, providerSession: session });
      });
      const ready = Effect.fn("DevinCloud.ready")(function* () {
        session = {
          ...session,
          status: "ready",
          lastError: null,
          capabilities: CAPABILITIES,
          updatedAt: yield* DateTime.now,
        };
        yield* emit({ type: "provider_session.updated", driver: DRIVER, providerSession: session });
      });
      const observer = yield* makeTaskObserver(emit, uncertain, ready);
      const relay = yield* relays.open(launch, observer.update).pipe(
        Effect.mapError(
          (cause) =>
            new Adapter.ProviderAdapterOpenSessionError({
              driver: DRIVER,
              providerSessionId: opened.providerSessionId,
              cause,
            }),
        ),
      );
      yield* Effect.addFinalizer(() => observer.close);
      const submissionGate = yield* Semaphore.make(1);
      let confirmedRepositoryId: string | undefined;
      let creationAttempted = false;
      const resume = Effect.fn("DevinCloud.resumeThread")(function* (
        thread: OrchestrationV2ProviderThread,
      ) {
        const nativeId = thread.nativeThreadRef?.nativeId;
        if (
          !nativeId ||
          thread.driver !== DRIVER ||
          thread.providerInstanceId !== instanceId ||
          thread.nativeThreadRef?.driver !== DRIVER ||
          thread.nativeThreadRef.fingerprint !== launch.binding ||
          thread.cloudTask?.taskId !== nativeId
        )
          return yield* fail("Cloud session identity or sibling credential binding changed");
        if (
          current?.nativeThreadRef?.nativeId &&
          (current.nativeThreadRef.nativeId !== nativeId ||
            (current.nativeThreadRef.ordinal !== undefined &&
              (thread.nativeThreadRef.ordinal ?? -1) < current.nativeThreadRef.ordinal))
        ) {
          return yield* fail("Saved cloud session identity or prompt-count marker changed");
        }
        if (
          current?.cloudTask &&
          thread.cloudTask &&
          (current.cloudTask.source.repository !== thread.cloudTask.source.repository ||
            current.cloudTask.source.branch !== thread.cloudTask.source.branch ||
            current.cloudTask.source.sha !== thread.cloudTask.source.sha)
        ) {
          return yield* fail("Cloud session source changed without creating a new conversation");
        }
        current = thread;
        return thread;
      });
      const start = Effect.fn("DevinCloud.startTurn")(function* (
        input: Adapter.ProviderAdapterV2TurnInput,
      ) {
        yield* observer.assertIdle;
        if (input.message.attachments.length) return yield* fail("Devin Cloud accepts text only");
        if (session.status === "error" || input.providerThread.cloudTask?.status === "unknown") {
          return yield* fail("Cloud task tracking must be recovered before sending a follow-up");
        }
        if (
          !input.commitCloudTask ||
          !input.commitCloudTaskMetadata ||
          !input.providerThread.cloudTask ||
          !input.cloudSource
        ) {
          return yield* fail(
            "Cloud base did not supply durable submitting intent/source and acceptance callbacks",
          );
        }
        const savedSource = input.providerThread.cloudTask.source;
        const sameSource = (source: typeof savedSource) =>
          source.repository === savedSource.repository &&
          source.branch === savedSource.branch &&
          source.sha === savedSource.sha;
        if (
          input.providerThread.cloudTask.status !== "submitting" ||
          !sameSource(input.cloudSource) ||
          (current?.cloudTask && !sameSource(current.cloudTask.source))
        ) {
          return yield* fail("Cloud source changed or durable submitting intent is missing");
        }
        const needsNewSession = !input.providerThread.nativeThreadRef?.nativeId;
        const ordinal = needsNewSession ? 0 : input.providerThread.nativeThreadRef?.ordinal;
        if (ordinal === undefined || !Number.isSafeInteger(ordinal) || ordinal < 0) {
          return yield* fail(
            "Saved Devin session has no confirmed prompt-count marker; review the session before continuing",
          );
        }
        if (
          !needsNewSession &&
          current?.nativeThreadRef?.ordinal !== undefined &&
          ordinal < current.nativeThreadRef.ordinal
        ) {
          return yield* fail("Saved Devin session prompt-count marker is stale");
        }
        const prompt = sourcePrompt(input.providerThread, input.message.text, ordinal === 0);
        if (!prompt)
          return yield* fail("Cloud base did not resolve a pushed repository, branch and SHA");
        let acceptedThread = input.providerThread;
        let repositoryConfirmed = true;
        if (needsNewSession) {
          if (creationAttempted || current?.nativeThreadRef?.nativeId)
            return yield* fail(
              "This runtime already attempted creation; recover the durable identity instead of retrying",
            );
          creationAttempted = true;
          const reply = yield* relay.create.pipe(
            Effect.mapError((cause) =>
              fail("Cloud creation was not confirmed; do not automatically retry", cause),
            ),
          );
          if (!reply.sessionId.trim())
            return yield* fail(
              "Cloud creation returned no session identity; do not retry automatically",
            );
          acceptedThread = {
            ...acceptedThread,
            cloudTask: { ...acceptedThread.cloudTask!, ...sessionMetadata(reply._meta) },
            nativeThreadRef: {
              driver: DRIVER,
              nativeId: reply.sessionId,
              strength: "strong",
              fingerprint: launch.binding,
              ordinal: 0,
            },
          };
        } else {
          yield* resume(acceptedThread);
          const id = acceptedThread.nativeThreadRef!.nativeId!;
          if (confirmedRepositoryId !== id) {
            const reply = yield* relay
              .attach(id)
              .pipe(
                Effect.mapError((cause) =>
                  fail("Existing cloud session could not be loaded", cause),
                ),
              );
            repositoryConfirmed = Relay.validateRepositorySelection(
              reply.configOptions,
              savedSource,
            );
            acceptedThread = {
              ...acceptedThread,
              cloudTask: { ...acceptedThread.cloudTask!, ...sessionMetadata(reply._meta) },
            };
          }
        }
        const id = acceptedThread.nativeThreadRef!.nativeId!;
        const accepted = {
          ...acceptedThread.cloudTask!,
          source: savedSource,
          taskId: id,
          status: "submitting" as const,
          tracking: "live" as const,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* input
          .commitCloudTask(accepted, {
            nativeThreadRef: acceptedThread.nativeThreadRef,
            nativeConversationHeadRef: acceptedThread.nativeConversationHeadRef,
          })
          .pipe(
            Effect.tapError(() =>
              uncertain(
                "Cloud identity acceptance failed; no prompt was sent and no automatic retry is allowed.",
              ),
            ),
          );
        current = { ...acceptedThread, cloudTask: accepted };
        yield* observer.bind({ ...input, providerThread: current }, false);
        // Configure version, platform and repository before the first prompt. A saved session that
        // never received one (its setup was refused, say before repository access was granted)
        // configures again rather than staying stuck.
        if (needsNewSession || (!repositoryConfirmed && ordinal === 0)) {
          yield* relay
            .configureSource(id, savedSource, { model, platform })
            .pipe(
              Effect.catch((cause) =>
                observer
                  .rejectSource(cause.message)
                  .pipe(Effect.andThen(Effect.fail(fail(cause.message, cause)))),
              ),
            );
          repositoryConfirmed = true;
        }
        if (!repositoryConfirmed) {
          const reason =
            "Devin did not confirm the saved repository; no prompt was sent. Review the session repository in Devin";
          yield* observer.rejectSource(reason);
          return yield* fail(reason);
        }
        confirmedRepositoryId = id;
        yield* observer.run(relay, prompt).pipe(Effect.forkIn(scope));
      });
      return {
        instanceId,
        driver: DRIVER,
        providerSessionId: opened.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(queue),
        ensureThread: (input) =>
          input.existingProviderThread?.nativeThreadRef?.nativeId
            ? resume(input.existingProviderThread)
            : Effect.fail(
                fail(
                  "New cloud identity is created by startTurn after durable intent; base must bypass ensureThread",
                ),
              ),
        resumeThread: ({ providerThread }) => resume(providerThread),
        startTurn: (input) => submissionGate.withPermit(start(input)),
        resumeTurn: Effect.fn("DevinCloud.resumeTurn")(function* (
          input: Parameters<NonNullable<Adapter.ProviderAdapterV2SessionRuntime["resumeTurn"]>>[0],
        ) {
          yield* observer.assertIdle;
          if (!input.commitCloudTaskMetadata)
            return yield* fail("Cloud base did not supply durable session metadata ingestion");
          yield* resume(input.providerThread);
          yield* observer.bind(
            { ...input, providerThread: { ...input.providerThread, cloudTask: input.cloudTask } },
            true,
          );
          yield* observer.attach(relay);
          confirmedRepositoryId = undefined;
        }),
        steerTurn: () =>
          Effect.fail(fail("Devin Cloud queues follow-ups; active steering is unavailable")),
        interruptTurn: ({ providerThread, providerTurnId }) =>
          Effect.gen(function* () {
            if (current?.id !== providerThread.id)
              return yield* fail("Cloud task is not attached to this runtime");
            yield* observer.cancel(relay, providerTurnId).pipe(
              Effect.mapError(
                (cause) =>
                  new Adapter.ProviderAdapterInterruptError({
                    driver: DRIVER,
                    providerThreadId: providerThread.id,
                    providerTurnId,
                    cause,
                  }),
              ),
            );
          }),
        respondToRuntimeRequest: () => Effect.fail(fail("Cloud host callbacks are not supported")),
        readThreadSnapshot: () => Effect.fail(fail("Cloud transcript read-back is not supported")),
        rollbackThread: () => Effect.fail(fail("Cloud runs have no local checkpoints")),
        forkThread: () => Effect.fail(fail("Cloud session forking is not supported")),
      } satisfies Adapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
