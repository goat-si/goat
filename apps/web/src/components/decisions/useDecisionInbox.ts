import { useAtomValue } from "@effect/atom-react";
import {
  durableDecisionAnswer,
  isDecisionItemRemoved,
  orderDecisionQueue,
  type DecisionItem,
} from "@goat/client-runtime/state/decision-inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { PendingUserInputDraftAnswer } from "@goat/client-runtime/state/user-input-draft";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
} from "@goat/contracts";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentScope } from "../../state/session";
import { decisionInbox } from "../../state/decisionInbox";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { DecisionAnswer, DecisionDraft } from "./DecisionDurableForm";

type QuestionDrafts = Record<string, PendingUserInputDraftAnswer>;
type InboxDrafts = Record<string, QuestionDrafts>;
type Submission =
  | { phase: "submitting" | "awaitingProjection" }
  | { phase: "failed"; message: string };

function prune<A>(values: Record<string, A>, keep: (id: string) => boolean) {
  const entries = Object.entries(values);
  const kept = entries.filter(([id]) => keep(id));
  return kept.length === entries.length ? values : Object.fromEntries(kept);
}

export function useDecisionInbox() {
  const snapshot = useAtomValue(decisionInbox.itemsAtom);
  const [skippedIds, setSkippedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<InboxDrafts>({});
  // Durable choices survive Skip like question drafts do, until the decision leaves the feed.
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, DecisionDraft>>({});
  const [submissions, setSubmissions] = useState<Record<string, Submission>>({});
  const inFlight = useRef(new Set<string>());
  const approval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const userInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const answerDecision = useAtomCommand(serverEnvironment.answerDecision, {
    reportFailure: false,
  });
  const ordered = orderDecisionQueue(snapshot.items, skippedIds);
  const current = ordered.find((item) => item.id === activeId) ?? ordered[0] ?? null;
  // Initial partial results stay unpinned until loading finishes or the user acts.
  if ((!snapshot.isLoading || activeId !== null) && (current?.id ?? null) !== activeId)
    setActiveId(current?.id ?? null);

  function skip() {
    if (!current || ordered.length < 2) return;
    const nextSkipped = [...skippedIds.filter((id) => id !== current.id), current.id];
    const next = orderDecisionQueue(snapshot.items, nextSkipped);
    setSkippedIds(nextSkipped);
    setActiveId(next.find((item) => item.id !== current.id)?.id ?? current.id);
  }

  function setAnswers(id: string, answers: QuestionDrafts) {
    if (current?.id === id) setActiveId(id);
    setDrafts((previous) => ({ ...previous, [id]: answers }));
  }

  function setDecisionDraft(id: string, draft: DecisionDraft) {
    if (current?.id === id) setActiveId(id);
    setDecisionDrafts((previous) => ({ ...previous, [id]: draft }));
  }

  function fail(id: string, message: string) {
    setSubmissions((previous) => ({ ...previous, [id]: { phase: "failed", message } }));
  }

  async function submit(
    id: string,
    response: ProviderApprovalDecision | Record<string, string | string[]> | DecisionAnswer,
  ) {
    const latest = appAtomRegistry.get(decisionInbox.itemsAtom);
    const live = latest.items.find((item) => item.id === id);
    if (!live || inFlight.current.has(id)) return;
    if (live.kind === "decision") {
      if (typeof response === "string" || typeof response.optionId !== "string") return;
      return submitDecision(live, { optionId: response.optionId, reason: String(response.reason) });
    }
    const sameRef = (ref: ScopedThreadRef) =>
      ref.environmentId === live.ref.environmentId && ref.threadId === live.ref.threadId;
    if (latest.loadingRefs.some(sameRef) || latest.errors.some(({ ref }) => sameRef(ref))) {
      fail(id, "Wait for this thread to reconnect before answering.");
      return;
    }
    if (live.request.responseCapability === "not_resumable") return;
    if (!readEnvironmentScope(live.ref.environmentId, AuthOrchestrationOperateScope)) {
      fail(id, "This connection cannot answer decisions.");
      return;
    }
    if ((live.kind === "approval") !== (typeof response === "string")) return;
    setActiveId(id);
    inFlight.current.add(id);
    setSubmissions((previous) => ({ ...previous, [id]: { phase: "submitting" } }));
    try {
      const input = { threadId: live.ref.threadId, requestId: live.request.requestId };
      const result =
        live.kind === "approval" && typeof response === "string"
          ? await approval({
              environmentId: live.ref.environmentId,
              input: { ...input, decision: response },
            })
          : typeof response !== "string"
            ? await userInput({
                environmentId: live.ref.environmentId,
                input: { ...input, answers: response },
              })
            : null;
      if (!result) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        fail(
          id,
          isAtomCommandInterrupted(result)
            ? "Answer interrupted. Try again."
            : error instanceof Error
              ? error.message
              : "Could not send answer.",
        );
        inFlight.current.delete(id);
      } else {
        setSubmissions((previous) => ({ ...previous, [id]: { phase: "awaitingProjection" } }));
        // A receipt is not removal: hold the lock until projection drops this ID.
      }
    } catch (error) {
      fail(id, error instanceof Error ? error.message : "Could not send answer.");
      inFlight.current.delete(id);
    }
  }

  async function submitDecision(
    live: Extract<DecisionItem, { kind: "decision" }>,
    answer: DecisionAnswer,
  ) {
    const input = durableDecisionAnswer(live.decision, answer.optionId, answer.reason);
    if (input === null) return;
    // Durable decisions come from the environment's feed, not the thread's detail.
    if (
      !appAtomRegistry
        .get(decisionInbox.itemsAtom)
        .feedEnvironments.includes(live.ref.environmentId)
    ) {
      fail(live.id, "Wait for decisions to load before answering.");
      return;
    }
    if (!readEnvironmentScope(live.ref.environmentId, AuthOrchestrationOperateScope)) {
      fail(live.id, "This connection cannot answer decisions.");
      return;
    }
    setActiveId(live.id);
    inFlight.current.add(live.id);
    setSubmissions((previous) => ({ ...previous, [live.id]: { phase: "submitting" } }));
    const result = await answerDecision({
      environmentId: live.ref.environmentId,
      input,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      fail(live.id, error instanceof Error ? error.message : "Could not send answer.");
      inFlight.current.delete(live.id);
    } else {
      // Held until the feed drops the decision, as projection does for thread requests.
      setSubmissions((previous) => ({ ...previous, [live.id]: { phase: "awaitingProjection" } }));
    }
  }

  // Forget removed items during render. Submissions count too: a receipt or failure can
  // land after projection already dropped its item.
  const [prunedFor, setPrunedFor] = useState({ snapshot, submissions });
  if (prunedFor.snapshot !== snapshot || prunedFor.submissions !== submissions) {
    const keep = (id: string) => !isDecisionItemRemoved(snapshot, id);
    const keptSubmissions = prune(submissions, keep);
    setPrunedFor({ snapshot, submissions: keptSubmissions });
    setSkippedIds((previous) => {
      const next = previous.filter(keep);
      return next.length === previous.length ? previous : next;
    });
    setDrafts((previous) => prune(previous, keep));
    setDecisionDrafts((previous) => prune(previous, keep));
    if (keptSubmissions !== submissions) setSubmissions(keptSubmissions);
  }
  useEffect(() => {
    for (const id of inFlight.current) {
      if (isDecisionItemRemoved(snapshot, id)) inFlight.current.delete(id);
    }
  }, [snapshot]);

  return {
    snapshot,
    ordered,
    current,
    drafts,
    decisionDrafts,
    setDecisionDraft,
    submissions,
    skip,
    setAnswers,
    submit,
    position: current ? ordered.findIndex((item) => item.id === current.id) + 1 : 0,
  };
}
