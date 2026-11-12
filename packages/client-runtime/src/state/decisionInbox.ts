import type {
  DecisionFeed,
  DecisionHandoff,
  DecisionItem as DurableDecision,
  EnvironmentId,
  Handoff,
  ScopedThreadRef,
} from "@goat/contracts";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { parseThreadKey, threadKey, threadRefsEqual } from "./entities.ts";
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
  /** An approval handoff; its card answers it through the handoff RPCs. */
  | { readonly kind: "handoff"; readonly handoff: Handoff }
);

const PERSON: DecisionRouting = { routedTo: "person" };

/** What the inbox says about approvals open beyond the ones its capped feed lists. */
export function unlistedApprovalsNotice(count: number) {
  return count === 1
    ? "1 older approval is not listed here. It is docked in its thread, which the thread list shows as waiting for you."
    : `${count} older approvals are not listed here. Each is docked in its thread, which the thread list shows as waiting for you.`;
}

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
const handoffKey = (environmentId: string, id: string) =>
  JSON.stringify(["handoff", environmentId, id]);

function handoffRouting(environmentId: EnvironmentId, entry: DecisionHandoff): DecisionRouting {
  return {
    routedTo: "person",
    threadTitle: entry.threadTitle,
    ...(entry.parentThreadId === undefined
      ? {}
      : { parentRef: { environmentId, threadId: entry.parentThreadId } }),
    ...(entry.parentThreadTitle === undefined ? {} : { parentTitle: entry.parentThreadTitle }),
  };
}

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
    readonly catalogEnvironments?: ReadonlyArray<EnvironmentId>;
  },
  id: string,
): boolean {
  if (snapshot.items.some((item) => item.id === id)) return false;
  // Pending ids are [environmentId, threadId, requestId]; feed-owned ones [kind, environmentId, id].
  const [first, second] = JSON.parse(id) as [string, string, string];
  if (first === "decision" || first === "handoff")
    return (
      (snapshot.feedEnvironments ?? []).some((environmentId) => environmentId === second) ||
      (snapshot.catalogEnvironments !== undefined &&
        !snapshot.catalogEnvironments.some((environmentId) => environmentId === second))
    );
  return snapshot.authoritativeRefs.some(
    (ref) => ref.environmentId === first && ref.threadId === second,
  );
}

/**
 * Whether an item cannot be answered yet but has not gone: a feed-owned item (durable decision or
 * approval handoff) while its still-enabled environment's feed is away, a thread request while its
 * thread loads or fails to. An environment removed or disabled has taken its items with it.
 */
export function isDecisionItemWaiting(
  snapshot: {
    readonly feedEnvironments: ReadonlyArray<EnvironmentId>;
    readonly catalogEnvironments?: ReadonlyArray<EnvironmentId>;
    readonly loadingRefs: ReadonlyArray<ScopedThreadRef>;
    readonly errors: ReadonlyArray<{ readonly ref: ScopedThreadRef }>;
  },
  item: DecisionItem,
): boolean {
  if (item.kind === "decision" || item.kind === "handoff")
    return (
      !snapshot.feedEnvironments.includes(item.ref.environmentId) &&
      (snapshot.catalogEnvironments === undefined ||
        snapshot.catalogEnvironments.includes(item.ref.environmentId))
    );
  return (
    snapshot.loadingRefs.some((ref) => threadRefsEqual([ref], [item.ref])) ||
    snapshot.errors.some(({ ref }) => threadRefsEqual([ref], [item.ref]))
  );
}

/** Same approvals in the same states: feed updates decode fresh objects, so compare what shows. */
function sameHandoffs(left: ReadonlyArray<Handoff>, right: ReadonlyArray<Handoff>) {
  return (
    left.length === right.length &&
    left.every(
      (handoff, index) =>
        handoff.handoffId === right[index]?.handoffId && handoff.state === right[index]?.state,
    )
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
    "pendingRequestsAtom" | "pendingHandoffsAtom" | "statusAtom" | "errorAtom"
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

  // The last approval list each enabled environment's feed gave. A disconnected environment keeps
  // its list, so an approval stays listed (and cannot be answered) until a loaded feed drops it.
  // A loaded feed that cannot list approvals (an older server) confirms none, so it forgets them.
  type Known = { readonly handoffs: ReadonlyArray<DecisionHandoff>; readonly open: number };
  let knownHandoffs: ReadonlyMap<EnvironmentId, Known> = new Map();
  const knownHandoffsAtom = Atom.make((get) => {
    const connected = get(connectedAtom);
    const next = new Map<EnvironmentId, Known>();
    for (const [id, entry] of get(input.catalogValueAtom).entries) {
      if (!entry.enabled) continue;
      const feed =
        input.feedAtom !== undefined && connected.includes(id) ? get(input.feedAtom(id)) : null;
      // A feed that sends only the newest approvals says how many are open in all.
      const known: Known | undefined =
        feed === null
          ? knownHandoffs.get(id)
          : feed.handoffs === undefined
            ? undefined
            : { handoffs: feed.handoffs, open: feed.handoffsTotal ?? feed.handoffs.length };
      if (known !== undefined && known.open > 0) next.set(id, known);
    }
    knownHandoffs = next;
    return next;
  }).pipe(Atom.withLabel("decision-inbox-known-handoffs"));

  let previousSummary: Summary = { count: 0, total: 0, refs: [] };
  const summaryAtom = Atom.make((get) => {
    const connected = get(connectedAtom);
    const unique = new Map<string, ScopedThreadRef>();
    const flagged = new Map<EnvironmentId, ScopedThreadRef[]>();
    // Threads flagged only for an approval; a known approval handoff may already count them.
    const approvalOnly = new Set<string>();
    for (const thread of get(input.threadShellsAtom)) {
      if (
        !connected.includes(thread.environmentId) ||
        (!thread.hasPendingApprovals && !thread.hasPendingUserInput)
      )
        continue;
      const ref = { environmentId: thread.environmentId, threadId: thread.id };
      if (!unique.has(threadKey(ref))) {
        const refs = flagged.get(thread.environmentId);
        if (refs === undefined) flagged.set(thread.environmentId, [ref]);
        else refs.push(ref);
      }
      if (!thread.hasPendingUserInput) approvalOnly.add(threadKey(ref));
      unique.set(threadKey(ref), ref);
    }
    const known = get(knownHandoffsAtom);
    let count = 0;
    let total = 0;
    for (const environmentId of connected) {
      const feed = input.feedAtom === undefined ? null : get(input.feedAtom(environmentId));
      if (feed === null) {
        const handoffThreads = new Set(
          (known.get(environmentId)?.handoffs ?? []).map((entry) =>
            threadKey({ environmentId, threadId: entry.handoff.requestedBy.threadId }),
          ),
        );
        const shellOnly = (flagged.get(environmentId) ?? []).filter(
          (ref) => !(approvalOnly.has(threadKey(ref)) && handoffThreads.has(threadKey(ref))),
        ).length;
        count += shellOnly;
        total += shellOnly;
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
    // Approval handoffs always wait on the person, including while their environment is away.
    for (const entry of known.values()) {
      count += entry.open;
      total += entry.open;
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
    const catalogEnvironments: EnvironmentId[] = [];
    for (const [id, entry] of get(input.catalogValueAtom).entries) {
      if (entry.enabled) catalogEnvironments.push(id);
    }
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
    // Approvals open beyond what the capped feeds list; each stays docked in its own thread.
    let unlistedApprovals = 0;
    for (const [environmentId, known] of get(knownHandoffsAtom)) {
      unlistedApprovals += Math.max(known.open - known.handoffs.length, 0);
      for (const entry of known.handoffs) {
        items.push({
          id: handoffKey(environmentId, entry.handoff.handoffId),
          ref: { environmentId, threadId: entry.handoff.requestedBy.threadId },
          kind: "handoff",
          createdAt: DateTime.formatIso(entry.handoff.createdAt),
          routing: handoffRouting(environmentId, entry),
          handoff: entry.handoff,
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
      catalogEnvironments,
      unlistedApprovals,
      loadingRefs,
      errors,
      isLoading: loadingRefs.length > 0,
    };
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel("decision-inbox-items"));

  /**
   * A thread's open approval handoffs for its composer. Reading it keeps the environment's feed
   * subscribed. A loaded feed that cannot list them all (an older server, or more open than it
   * sends) falls back to the thread's loaded items, which keep every waiting approval; reading
   * those loads the thread.
   */
  const openApprovalsAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let value: ReadonlyArray<Handoff> = [];
    return Atom.make((get) => {
      // Observed even while the feed is loaded, so a dock alone still remembers it.
      const known = get(knownHandoffsAtom);
      const feed = input.feedAtom === undefined ? null : get(input.feedAtom(ref.environmentId));
      const forThread = (handoffs: ReadonlyArray<DecisionHandoff>) =>
        handoffs.flatMap((entry) =>
          entry.handoff.requestedBy.threadId === ref.threadId ? [entry.handoff] : [],
        );
      // While the feed is away, the last list it gave stays docked; feedAwayAtom disables it.
      let next: ReadonlyArray<Handoff>;
      // A cached or failed thread detail can still hold an approval answered elsewhere.
      const liveLoaded = () =>
        get(input.details.statusAtom(ref)) === "live" && get(input.details.errorAtom(ref)) === null
          ? get(input.details.pendingHandoffsAtom(ref))
          : [];
      if (feed === null) next = forThread(known.get(ref.environmentId)?.handoffs ?? []);
      else if (feed.handoffs === undefined) next = liveLoaded();
      else if ((feed.handoffsTotal ?? feed.handoffs.length) > feed.handoffs.length) {
        // Capped: the thread's loaded approvals plus the feed's, since a server without snapshot
        // retention can leave a listed one outside the loaded history.
        const loaded = liveLoaded();
        const ids = new Set(loaded.map((handoff) => handoff.handoffId));
        next = [...loaded, ...forThread(feed.handoffs).filter((h) => !ids.has(h.handoffId))];
      } else next = forThread(feed.handoffs);
      if (!sameHandoffs(value, next)) value = next;
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`decision-inbox-open-approvals:${key}`));
  });

  /**
   * Whether the environment's approvals cannot be answered yet: it is disconnected, or its feed has
   * not loaded since. Known approvals stay shown but disabled until a loaded feed confirms them.
   */
  const feedAwayAtomFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        !get(connectedAtom).includes(environmentId) ||
        (input.feedAtom !== undefined && get(input.feedAtom(environmentId)) === null),
    ).pipe(Atom.withLabel("decision-inbox-feed-away:" + environmentId)),
  );

  return {
    summaryAtom,
    itemsAtom,
    openApprovalsAtom: (ref: ScopedThreadRef) => openApprovalsAtomFamily(threadKey(ref)),
    feedAwayAtom: (environmentId: EnvironmentId) => feedAwayAtomFamily(environmentId),
  };
}
