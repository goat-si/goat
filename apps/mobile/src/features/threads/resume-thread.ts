import type {
  ResumeThreadQueueInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
} from "@goat/client-runtime/operations";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { resolveProviderInteractionMode } from "../../state/legacy-plan-mode";

type Command<Input, E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<unknown, E>>;

interface ResumedThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

interface ModeCommands<E> {
  readonly thread: ResumedThread;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
  readonly setRuntimeMode: Command<SetThreadRuntimeModeInput, E>;
  readonly setInteractionMode: Command<SetThreadInteractionModeInput, E>;
}

/**
 * Turns on an existing thread, continued or released from the queue, run with its saved modes.
 * Resolves to the failed command's result, so a refused mode resumes nothing.
 */
async function saveComposerModes<E>(
  input: ModeCommands<E>,
): Promise<AtomCommandResult<unknown, E> | null> {
  const { thread, runtimeMode, interactionMode, createdAt } = input;
  const environmentId = thread.environmentId;
  if (runtimeMode !== thread.runtimeMode) {
    const saved = await input.setRuntimeMode({
      environmentId,
      input: { threadId: thread.id, runtimeMode, createdAt },
    });
    if (saved._tag === "Failure") return saved;
  }
  if (interactionMode !== thread.interactionMode) {
    const saved = await input.setInteractionMode({
      environmentId,
      input: { threadId: thread.id, interactionMode, createdAt },
    });
    if (saved._tag === "Failure") return saved;
  }
  return null;
}

/** Resolves to the first failed command's result, or the last successful one. */
export async function resumeThread<E>(
  input: ModeCommands<E> & {
    readonly resumableRunId: RunId | null;
    readonly queueHeld: boolean;
    readonly modelSelection: ModelSelection | null;
    readonly messageId: MessageId;
    readonly startTurn: Command<StartThreadTurnInput, E>;
    readonly resumeQueue: Command<ResumeThreadQueueInput, E>;
  },
): Promise<AtomCommandResult<unknown, E>> {
  const { thread, runtimeMode, interactionMode } = input;
  const environmentId = thread.environmentId;
  const failed = await saveComposerModes(input);
  if (failed !== null) return failed;
  // The server holds the queue behind a stopped or usage-limited run until that run is continued.
  if (input.resumableRunId !== null) {
    const continued = await input.startTurn({
      environmentId,
      input: {
        creationSource: "mobile",
        threadId: thread.id,
        manualContinuationOfRunId: input.resumableRunId,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        message: {
          messageId: input.messageId,
          role: "user",
          text: "Continue where you left off.",
          attachments: [],
        },
        runtimeMode,
        interactionMode,
        dispatchMode: "start",
      },
    });
    if (continued._tag === "Failure" || !input.queueHeld) return continued;
  }
  return input.resumeQueue({ environmentId, input: { threadId: thread.id } });
}

/**
 * The queue sheet's Resume queue: the composer draft's modes, as the composer's Resume. The sheet
 * can open before the thread has loaded; that press sends nothing and says so.
 */
export async function resumeHeldQueue<E>(
  input: Omit<ModeCommands<E>, "runtimeMode" | "interactionMode" | "thread"> & {
    readonly thread: ResumedThread | null;
    readonly draft: {
      readonly runtimeMode?: RuntimeMode | undefined;
      readonly interactionMode?: ProviderInteractionMode | undefined;
    };
    readonly provider: Parameters<typeof resolveProviderInteractionMode>[0];
    readonly resumeQueue: Command<ResumeThreadQueueInput, E>;
  },
): Promise<AtomCommandResult<unknown, E | Error>> {
  const { thread, draft } = input;
  if (thread === null)
    return AsyncResult.failure(
      Cause.fail(new Error("This thread is still loading. Try again in a moment.")),
    );
  const failed = await saveComposerModes({
    ...input,
    thread,
    runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
    interactionMode: resolveProviderInteractionMode(
      input.provider,
      draft.interactionMode ?? thread.interactionMode,
    ),
  });
  if (failed !== null) return failed;
  return input.resumeQueue({
    environmentId: thread.environmentId,
    input: { threadId: thread.id },
  });
}
