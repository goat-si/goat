import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type DecisionItem,
  durableDecisionAnswer,
  isDecisionItemRemoved,
  orderDecisionQueue,
} from "@goat/client-runtime/state/decision-inbox";
import {
  seedUserInputDraftAnswers,
  type ThreadUserInputQuestion,
} from "@goat/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { decisionInbox, environmentThreads, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const sameRef = (a: DecisionItem["ref"], b: DecisionItem["ref"]) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;
/** What an item asks; it changes identity when the asking side updates the request. */
const payloadOf = (item: DecisionItem | null) =>
  item === null ? null : item.kind === "decision" ? item.decision : item.request;

function prune<A>(values: Record<string, A>, keep: (id: string) => boolean) {
  const entries = Object.entries(values);
  const kept = entries.filter(([id]) => keep(id));
  return kept.length === entries.length ? values : Object.fromEntries(kept);
}

export function useDecisionInboxSessionState() {
  const [selected, setSelected] = useState<DecisionItem | null>(null);
  const [skippedIds, setSkippedIds] = useState<ReadonlyArray<string>>([]);
  const [draftsById, setDraftsById] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  // Durable choices survive Skip like question drafts do, until the decision leaves the feed.
  const [decisionDraftsById, setDecisionDraftsById] = useState<
    Record<string, { readonly optionId: string | null; readonly reason: string }>
  >({});
  const [busyById, setBusyById] = useState<Record<string, boolean>>({});
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const inFlight = useRef(new Map<string, DecisionItem>());
  return {
    selected,
    setSelected,
    skippedIds,
    setSkippedIds,
    draftsById,
    setDraftsById,
    decisionDraftsById,
    setDecisionDraftsById,
    busyById,
    setBusyById,
    errorsById,
    setErrorsById,
    inFlight,
  };
}

export function useDecisionInbox(
  session: ReturnType<typeof useDecisionInboxSessionState>,
  isFocused: () => boolean,
) {
  const registry = useContext(RegistryContext);
  const state = useAtomValue(decisionInbox.itemsAtom);
  const {
    selected,
    setSelected,
    skippedIds,
    setSkippedIds,
    draftsById,
    setDraftsById,
    decisionDraftsById,
    setDecisionDraftsById,
    busyById,
    setBusyById,
    errorsById,
    setErrorsById,
    inFlight,
  } = session;
  const queue = useMemo(
    () => orderDecisionQueue(state.items, skippedIds),
    [state.items, skippedIds],
  );
  const unresolved = useCallback(
    (item: DecisionItem) =>
      // Durable decisions come from the environment's feed, not the thread's detail.
      item.kind === "decision"
        ? !state.feedEnvironments.includes(item.ref.environmentId)
        : state.loadingRefs.some((ref) => sameRef(ref, item.ref)) ||
          state.errors.some(({ ref }) => sameRef(ref, item.ref)),
    [state.loadingRefs, state.errors, state.feedEnvironments],
  );
  const liveSelected =
    selected === null ? undefined : queue.find((item) => item.id === selected.id);
  const current =
    liveSelected ??
    (selected !== null && unresolved(selected)
      ? selected
      : state.isLoading && selected === null
        ? null
        : (queue[0] ?? null));
  const paused = current !== null && unresolved(current);
  const currentId = current?.id ?? null;
  const position = current === null ? 0 : queue.findIndex((item) => item.id === current.id) + 1;
  const canOperateThread =
    useEnvironmentScope(current?.ref.environmentId ?? null, AuthOrchestrationOperateScope) &&
    !paused;
  const drafts =
    current?.kind === "user_input"
      ? seedUserInputDraftAnswers(current.request.questions, draftsById[current.id] ?? {})
      : {};
  const answers =
    current?.kind === "user_input"
      ? buildPendingUserInputAnswers(current.request.questions, drafts)
      : null;
  const responding = currentId !== null && busyById[currentId] === true;
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "decision approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "decision question response",
  );
  const answerDecision = useAtomCommand(serverEnvironment.answerDecision, "decision answer");

  useEffect(() => {
    if (!isFocused()) return;
    if (selected?.id !== current?.id || payloadOf(selected) !== payloadOf(current))
      setSelected(current);
  }, [current, selected, setSelected, isFocused]);

  useEffect(() => {
    if (!isFocused()) return;
    const keep = (id: string) => !isDecisionItemRemoved(state, id);
    for (const id of inFlight.current.keys()) {
      if (!keep(id)) inFlight.current.delete(id);
    }
    setBusyById((previous) => prune(previous, (id) => inFlight.current.has(id)));
    setDraftsById((previous) => prune(previous, keep));
    setDecisionDraftsById((previous) => prune(previous, keep));
    setErrorsById((previous) => prune(previous, keep));
    setSkippedIds((previous) => {
      const next = previous.filter(keep);
      return next.length === previous.length ? previous : next;
    });
  }, [
    state,
    isFocused,
    inFlight,
    setBusyById,
    setDraftsById,
    setDecisionDraftsById,
    setErrorsById,
    setSkippedIds,
  ]);

  function readActionItem(id: string): DecisionItem | undefined {
    if (!isFocused()) return undefined;
    const latest = registry.get(decisionInbox.itemsAtom);
    const item = latest.items.find((entry) => entry.id === id);
    if (
      !item ||
      (item.kind === "decision"
        ? !latest.feedEnvironments.includes(item.ref.environmentId)
        : latest.loadingRefs.some((ref) => sameRef(ref, item.ref)) ||
          latest.errors.some(({ ref }) => sameRef(ref, item.ref))) ||
      !readEnvironmentScope(item.ref.environmentId, AuthOrchestrationOperateScope) ||
      (item.kind === "approval"
        ? item.request.responseCapability !== "live"
        : item.kind === "user_input" && item.request.responseCapability === "not_resumable")
    ) {
      setErrorsById((previous) => ({
        ...previous,
        [id]: "This decision is no longer available to answer. Open its thread to continue.",
      }));
      return undefined;
    }
    return item;
  }

  async function runResponse(
    item: DecisionItem,
    execute: () =>
      | ReturnType<typeof respondToApproval>
      | ReturnType<typeof respondToUserInput>
      | ReturnType<typeof answerDecision>,
  ) {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.set(item.id, item);
    setBusyById((previous) => ({ ...previous, [item.id]: true }));
    setErrorsById((previous) => prune(previous, (id) => id !== item.id));
    function fail(message: string) {
      // Projection removal may already have released this exact submission.
      if (inFlight.current.get(item.id) !== item) return;
      inFlight.current.delete(item.id);
      setBusyById((previous) => prune(previous, (id) => id !== item.id));
      setErrorsById((previous) => ({ ...previous, [item.id]: message }));
    }
    try {
      const result = await execute();
      if (result._tag === "Failure") {
        const cause: Cause.Cause<unknown> = result.cause;
        fail(Cause.pretty(cause));
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not send answer.");
    }
  }

  async function onRespond(requestId: RuntimeRequestId, decision: ProviderApprovalDecision) {
    if (current === null) return;
    const item = readActionItem(current.id);
    if (item?.kind !== "approval" || item.request.requestId !== requestId) return;
    const choices: ReadonlyArray<ProviderApprovalDecision> = item.request.options?.map(
      (option) => option.decision,
    ) ?? ["accept", "acceptForSession", "decline"];
    if (!choices.includes(decision)) return;
    return runResponse(item, () =>
      respondToApproval({
        environmentId: item.ref.environmentId,
        input: { threadId: item.ref.threadId, requestId: item.request.requestId, decision },
      }),
    );
  }

  async function onSubmit() {
    if (current === null) return;
    const item = readActionItem(current.id);
    if (item?.kind !== "user_input") return;
    const draft = seedUserInputDraftAnswers(item.request.questions, draftsById[item.id] ?? {});
    const submittedAnswers = buildPendingUserInputAnswers(item.request.questions, draft);
    if (submittedAnswers === null) return;
    return runResponse(item, () =>
      respondToUserInput({
        environmentId: item.ref.environmentId,
        input: {
          threadId: item.ref.threadId,
          requestId: item.request.requestId,
          answers: submittedAnswers,
        },
      }),
    );
  }

  function editableItem(requestId: RuntimeRequestId) {
    if (!current || paused || responding || !canOperateThread || inFlight.current.has(current.id))
      return;
    const item = readActionItem(current.id);
    return item?.kind === "user_input" && item.request.requestId === requestId ? item : undefined;
  }

  async function onAnswerDecision(optionId: string, reason: string) {
    if (current === null || paused || inFlight.current.has(current.id)) return;
    const item = readActionItem(current.id);
    if (item?.kind !== "decision") return;
    const input = durableDecisionAnswer(item.decision, optionId, reason);
    if (input === null) return;
    return runResponse(item, () =>
      answerDecision({ environmentId: item.ref.environmentId, input }),
    );
  }

  function onChangeDecisionDraft(optionId: string | null, reason: string) {
    if (current?.kind !== "decision" || inFlight.current.has(current.id)) return;
    const id = current.id;
    setDecisionDraftsById((previous) => ({ ...previous, [id]: { optionId, reason } }));
  }

  function onSelectOption(
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) {
    const item = editableItem(requestId);
    const liveQuestion = item?.request.questions.find((entry) => entry.id === question.id);
    if (!item || !liveQuestion) return;
    if (
      !liveQuestion.options.some(
        (option) =>
          (option.value ?? option.label.trim()) === value || option.label.trim() === value,
      )
    )
      return;
    setDraftsById((previous) => {
      const seeded = seedUserInputDraftAnswers(item.request.questions, previous[item.id] ?? {});
      return {
        ...previous,
        [item.id]: {
          ...seeded,
          [liveQuestion.id]: togglePendingUserInputOptionSelection(
            liveQuestion,
            seeded[liveQuestion.id],
            value,
          ),
        },
      };
    });
  }

  function onChangeCustomAnswer(requestId: RuntimeRequestId, questionId: string, value: string) {
    const item = editableItem(requestId);
    const question = item?.request.questions.find((entry) => entry.id === questionId);
    if (!item || !question || question.allowCustomAnswer === false) return;
    setDraftsById((previous) => {
      const seeded = seedUserInputDraftAnswers(item.request.questions, previous[item.id] ?? {});
      return {
        ...previous,
        [item.id]: {
          ...seeded,
          [question.id]: setPendingUserInputCustomAnswer(question, seeded[question.id], value),
        },
      };
    });
  }

  function skip() {
    if (!isFocused() || !current || paused || responding || inFlight.current.has(current.id))
      return;
    const nextSkipped = [...skippedIds.filter((id) => id !== current.id), current.id];
    setSkippedIds(nextSkipped);
    setSelected(orderDecisionQueue(state.items, nextSkipped)[0] ?? null);
  }

  function retry() {
    if (!isFocused()) return;
    const seen = new Set<string>();
    for (const { ref } of state.errors) {
      const key = JSON.stringify([ref.environmentId, ref.threadId]);
      if (seen.has(key)) continue;
      seen.add(key);
      registry.refresh(environmentThreads.stateAtom(ref.environmentId, ref.threadId));
    }
  }

  return {
    state,
    queue,
    current,
    position,
    paused,
    responding,
    drafts,
    answers,
    canOperateThread,
    error: currentId === null ? null : (errorsById[currentId] ?? null),
    skip,
    retry,
    onRespond,
    onSubmit,
    onAnswerDecision,
    onChangeDecisionDraft,
    decisionDraft: currentId === null ? undefined : decisionDraftsById[currentId],
    onSelectOption,
    onChangeCustomAnswer,
  };
}
