import type {
  DecisionFeed,
  DecisionItem as DurableDecision,
  EnvironmentId,
  ScopedThreadRef,
} from "@goat/contracts";
import { ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { threadKey, threadRefsEqual } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import type { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { ThreadPendingApproval, ThreadPendingUserInput } from "./threadRequests.ts";

/** Who is asked first, and the names the server resolved; person when the server said nothing. */
export type DecisionRouting = {
  readonly routedTo: "parent" | "person";
  readonly threadTitle?: string;
  readonly parentRef?: ScopedThreadRef;
  readonly parentTitle?: string;
  readonly escalation?: { readonly by: string; readonly at: string; readonly reason: string };
};

export type DecisionItem = {
  readonly id: string;
  readonly ref: ScopedThreadRef;
  readonly createdAt: string;
  readonly routing: DecisionRouting;
} & (
  | { readonly kind: "approval"; readonly request: ThreadPendingApproval }
  | { readonly kind: "user_input"; readonly request: ThreadPendingUserInput }
  | { readonly kind: "decision"; readonly decision: DurableDecision }
);

const PERSON: DecisionRouting = { routedTo: "person" };

/**
 * The reason sent with a person's answer. The server requires one: a projected request passes it
 * to its asking thread's response, a durable decision drops it. A blank reason names the choice.
 */
export function decisionAnswerReason(reason: string, choice: string) {
  const typed = reason.trim();
  return typed.length > 0 ? typed : `Chose ${choice}.`.slice(0, 2000);
}

/** A durable decision delivers only the chosen option, so clients ask for no reason. */
export function durableDecisionAnswer(decision: DurableDecision, optionId: string) {
  const option = decision.options.find((entry) => entry.id === optionId);
  if (option === undefined) return null;
  return { id: decision.id, optionId, reason: decisionAnswerReason("", option.label) };
}
const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const pendingKey = (environmentId: string, threadId: string, requestId: string) =>
  JSON.stringify([environmentId, threadId, requestId]);
const decisionKey = (environmentId: string, id: string) =>
  JSON.stringify(["decision", environmentId, id]);

function routingOf(environmentId: EnvironmentId, item: DurableDecision): DecisionRouting {
  const parentThreadId = item.from.parentThreadId;
  return {
    routedTo: item.routedTo ?? "person",
    ...(item.from.threadTitle === undefined ? {} : { threadTitle: item.from.threadTitle }),
    ...(parentThreadId === undefined
      ? {}
      : { parentRef: { environmentId, threadId: ThreadId.make(parentThreadId) } }),
    ...(item.from.parentThreadTitle === undefined
      ? {}
      : { parentTitle: item.from.parentThreadTitle }),
    ...(item.escalation === undefined ? {} : { escalation: item.escalation }),
  };
}

/** Feed items the inbox lists: open, from a thread here, and durable or a projected request. */
function listedFeedItems(feed: DecisionFeed) {
  return feed.items.filter(
    (item) =>
      item.status === "open" &&
      (item.source === "pending_request"
        ? item.pending !== undefined
        : item.from.threadId !== undefined),
  );
}

export function isDecisionItemRemoved(
  snapshot: {
    readonly items: ReadonlyArray<DecisionItem>;
    readonly authoritativeRefs: ReadonlyArray<ScopedThreadRef>;
    readonly feedEnvironments?: ReadonlyArray<EnvironmentId>;
  },
  id: string,
): boolean {
  if (snapshot.items.some((item) => item.id === id)) return false;
  // Pending ids are [environmentId, threadId, requestId]; durable ones ["decision", environmentId, id].
  const [first, second] = JSON.parse(id) as [string, string, string];
  if (first === "decision")
    return (snapshot.feedEnvironments ?? []).some((environmentId) => environmentId === second);
  return snapshot.authoritativeRefs.some(
    (ref) => ref.environmentId === first && ref.threadId === second,
  );
}

export function orderDecisionQueue(
  items: ReadonlyArray<DecisionItem>,
  skipOrder: ReadonlyArray<string>,
): ReadonlyArray<DecisionItem> {
  const skipped = new Map<string, number>();
  for (const id of skipOrder) {
    if (!skipped.has(id)) skipped.set(id, skipped.size);
  }
  const rank = (item: DecisionItem) => (item.routing.routedTo === "person" ? 0 : 1);
  return [...items].sort((left, right) => {
    const leftSkip = skipped.get(left.id);
    const rightSkip = skipped.get(right.id);
    if (leftSkip !== undefined || rightSkip !== undefined) {
      if (leftSkip === undefined) return -1;
      if (rightSkip === undefined) return 1;
      return leftSkip - rightSkip;
    }
    return (
      rank(left) - rank(right) ||
      compareStrings(left.createdAt, right.createdAt) ||
      compareStrings(left.id, right.id)
    );
  });
}

export function skipDecisionItem(
  items: ReadonlyArray<DecisionItem>,
  skipOrder: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> {
  const liveIds = new Set(items.map((item) => item.id));
  const next = [...new Set(skipOrder)].filter((key) => liveIds.has(key) && key !== id);
  if (liveIds.has(id)) next.push(id);
  return next;
}

type Summary = {
  /** Items the person should act on now. */
  readonly count: number;
  /** Everything listed, including items a parent agent is handling first. */
  readonly total: number;
  readonly refs: ReadonlyArray<ScopedThreadRef>;
};

export function createDecisionInboxAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
  readonly details: Pick<
    ReturnType<typeof createEnvironmentThreadDetailAtoms>,
    "pendingRequestsAtom" | "statusAtom" | "errorAtom"
  >;
  /** The environment's decision feed; null while unavailable (older servers, no read scope). */
  readonly feedAtom?: (environmentId: EnvironmentId) => Atom.Atom<DecisionFeed | null>;
}) {
  const connectedAtom = Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    const connected: EnvironmentId[] = [];
    for (const [id, entry] of catalog.entries) {
      if (entry.enabled && get(input.presentationAtom(id))?.connection.phase === "connected") {
        connected.push(id);
      }
    }
    return connected;
  }).pipe(Atom.withLabel("decision-inbox-connected"));

  let previousSummary: Summary = { count: 0, total: 0, refs: [] };
  const summaryAtom = Atom.make((get) => {
    const connected = get(connectedAtom);
    const unique = new Map<string, ScopedThreadRef>();
    const flagged = new Map<EnvironmentId, number>();
    for (const thread of get(input.threadShellsAtom)) {
      if (
        !connected.includes(thread.environmentId) ||
        (!thread.hasPendingApprovals && !thread.hasPendingUserInput)
      )
        continue;
      const ref = { environmentId: thread.environmentId, threadId: thread.id };
      if (!unique.has(threadKey(ref)))
        flagged.set(thread.environmentId, (flagged.get(thread.environmentId) ?? 0) + 1);
      unique.set(threadKey(ref), ref);
    }
    let count = 0;
    let total = 0;
    for (const environmentId of connected) {
      const feed = input.feedAtom === undefined ? null : get(input.feedAtom(environmentId));
      if (feed === null) {
        count += flagged.get(environmentId) ?? 0;
        total += flagged.get(environmentId) ?? 0;
        continue;
      }
      // A loaded feed is complete, so it alone decides what is counted.
      for (const item of listedFeedItems(feed)) {
        total += 1;
        if ((item.routedTo ?? "person") === "person") count += 1;
        const threadId = item.pending?.threadId;
        if (threadId !== undefined) {
          const ref = { environmentId, threadId };
          unique.set(threadKey(ref), ref);
        }
      }
    }
    const refs = [...unique.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, ref]) => ref);
    if (
      previousSummary.count === count &&
      previousSummary.total === total &&
      threadRefsEqual(previousSummary.refs, refs)
    )
      return previousSummary;
    previousSummary = { count, total, refs };
    return previousSummary;
  }).pipe(Atom.withLabel("decision-inbox-summary"));

  const itemsAtom = Atom.make((get) => {
    const items: DecisionItem[] = [];
    const authoritativeRefs: ScopedThreadRef[] = [];
    const loadingRefs: ScopedThreadRef[] = [];
    const errors: { readonly ref: ScopedThreadRef; readonly message: string }[] = [];
    const feedEnvironments: EnvironmentId[] = [];
    const pendingRouting = new Map<string, DecisionRouting>();
    for (const environmentId of get(connectedAtom)) {
      const feed = input.feedAtom === undefined ? null : get(input.feedAtom(environmentId));
      if (feed === null) continue;
      feedEnvironments.push(environmentId);
      for (const item of listedFeedItems(feed)) {
        if (item.pending !== undefined) {
          pendingRouting.set(
            pendingKey(environmentId, item.pending.threadId, item.pending.requestId),
            routingOf(environmentId, item),
          );
          continue;
        }
        const threadId = item.from.threadId;
        if (threadId === undefined) continue;
        items.push({
          id: decisionKey(environmentId, item.id),
          ref: { environmentId, threadId },
          kind: "decision",
          createdAt: item.createdAt,
          routing: routingOf(environmentId, item),
          decision: item,
        });
      }
    }
    for (const ref of get(summaryAtom).refs) {
      const pending = get(input.details.pendingRequestsAtom(ref));
      const status = get(input.details.statusAtom(ref));
      const error = get(input.details.errorAtom(ref));
      if (status === "deleted") continue;
      if (error !== null) errors.push({ ref, message: error });
      else if (status !== "live") loadingRefs.push(ref);
      if (pending === null) continue;
      if (status === "live" && error === null) authoritativeRefs.push(ref);
      for (const request of pending.approvals) {
        const id = pendingKey(ref.environmentId, ref.threadId, request.requestId);
        items.push({
          id,
          ref,
          kind: "approval",
          createdAt: request.createdAt,
          routing: pendingRouting.get(id) ?? PERSON,
          request,
        });
      }
      for (const request of pending.userInputs) {
        const id = pendingKey(ref.environmentId, ref.threadId, request.requestId);
        items.push({
          id,
          ref,
          kind: "user_input",
          createdAt: request.createdAt,
          routing: pendingRouting.get(id) ?? PERSON,
          request,
        });
      }
    }
    return {
      items: orderDecisionQueue(items, []),
      authoritativeRefs,
      feedEnvironments,
      loadingRefs,
      errors,
      isLoading: loadingRefs.length > 0,
    };
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("decision-inbox-items"));

  return { summaryAtom, itemsAtom };
}
