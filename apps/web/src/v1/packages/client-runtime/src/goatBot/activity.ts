import {
  isGoatBotSessionThreadId,
  type ChannelTaskChip,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { GoatBotItemReaders } from "./rows.ts";

/**
 * What GOAT Bot's "..." says: reading the newest message, or how the work it acknowledged is going.
 * It reads the task's own updates, and from the worker only run status and pending requests, never
 * tool calls. Worker state counts only when it provably belongs to the task's run, because a GOAT
 * Bot session thread serves several tasks one run at a time.
 */
export interface GoatBotActivity {
  readonly state: "reading" | "working";
  /** One line, cut to fit; `fullText` is the whole step when it was cut. */
  readonly text: string;
  readonly fullText?: string;
  /** Set when the work waits on the person (an answer, approval, sign-in) or a usage limit. */
  readonly attention?: "waiting" | "paused";
  /**
   * What the step waits on, whatever its words: the person, other work, or a usage limit. A wait
   * reworded as more is known ("Waiting for you", then "Waiting for your answer") keeps its kind.
   * Absent for a working step, including a task update that reads like a wait.
   */
  readonly wait?: GoatBotWaitKind;
}

export type GoatBotWaitKind = "you" | "other_work" | "usage_limit";

/** The task the working indicator follows and its newest update in the conversation. */
export interface GoatBotActivityTask {
  readonly chip: ChannelTaskChip;
  readonly update: string | null;
}

/** What this client already holds for a worker thread. Nothing is loaded for the indicator. */
export interface GoatBotWorkerObservation {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "pendingRuntimeRequest" | "latestRunStartHeld"
  > | null;
  readonly projection: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "startHold">>;
    readonly nodes: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "runId">>;
    readonly runtimeRequests: ReadonlyArray<
      Pick<OrchestrationV2RuntimeRequest, "nodeId" | "kind" | "status">
    >;
  } | null;
}

const GOAT_BOT_READING_TEXT = "Reading your message";
const ACTIVITY_TEXT_LIMIT = 120;
const OUTSTANDING: ReadonlySet<ChannelTaskChip["status"]> = new Set([
  "received",
  "dispatching",
  "running",
  "waiting_input",
]);

/** A finished task stays in view only while a coding thread still needs an approval. */
export const goatBotChipOutstanding = (chip: ChannelTaskChip) =>
  OUTSTANDING.has(chip.status) ||
  ((chip.status === "completed" || chip.status === "failed") &&
    (chip.observed?.needsYou.some((item) => item.kind === "approval") ?? false));
const TASK_STATUS_TEXT: Partial<Record<ChannelTaskChip["status"], string>> = {
  received: "Getting ready",
  dispatching: "Starting",
  running: "Working",
  waiting_input: "Waiting for you",
};
const RUN_STATUS_TEXT: Partial<Record<string, string>> = {
  preparing: "Starting",
  queued: "Starting",
  starting: "Starting",
  running: "Working",
  waiting: "Waiting on other work",
};

/**
 * The newest acknowledged task still outstanding. An acknowledgement is a bot reply to one of the
 * person's messages that names the task; card order alone never ties work to a message.
 */
export function goatBotActivityTask(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly readers: GoatBotItemReaders;
}): GoatBotActivityTask | null {
  const chips = new Map<string, ChannelTaskChip>();
  const acknowledged = new Map<string, number>();
  const updates = new Map<string, string>();
  const inputs = new Set<string>();
  input.visibleTurnItems.forEach(({ item }, index) => {
    if (item.type === "notification" && item.ledgerTask !== undefined) {
      const previous = chips.get(item.ledgerTask.taskId);
      if (previous === undefined || item.ledgerTask.taskVersion > previous.taskVersion) {
        chips.set(item.ledgerTask.taskId, item.ledgerTask);
      }
      return;
    }
    if (item.type === "user_message") {
      const requestKey = input.readers.message(item)?.requestKey;
      if (requestKey) inputs.add(requestKey);
      return;
    }
    if (item.type !== "assistant_message") return;
    const presentation = input.readers.message(item);
    const taskId = presentation?.taskId;
    if (!presentation || !taskId) return;
    if (presentation.replyToKey && inputs.has(presentation.replyToKey)) {
      acknowledged.set(taskId, index);
    } else if (
      acknowledged.has(taskId) &&
      (presentation.tone === "reply" || presentation.tone === "status") &&
      item.text.trim() !== ""
    ) {
      updates.set(taskId, item.text);
    }
  });
  let newest: { readonly chip: ChannelTaskChip; readonly index: number } | null = null;
  for (const [taskId, index] of acknowledged) {
    const chip = chips.get(taskId);
    if (chip === undefined || !goatBotChipOutstanding(chip)) continue;
    if (newest === null || index > newest.index) newest = { chip, index };
  }
  if (newest === null) return null;
  return { chip: newest.chip, update: updates.get(newest.chip.taskId) ?? null };
}

/** Reading wins; otherwise what waits on the person, then the followed task's newest update. */
export function goatBotActivity(input: {
  readonly reading: boolean;
  readonly task: GoatBotActivityTask | null;
  readonly worker: GoatBotWorkerObservation | null;
}): GoatBotActivity | null {
  if (input.reading) return { state: "reading", text: GOAT_BOT_READING_TEXT };
  if (input.task === null) return null;
  const { chip, update } = input.task;
  const run = runEvidence(chip, input.worker);
  const summary = chip.summary?.trim() ? chip.summary : null;
  const needed = attention(chip);
  const text =
    needed?.text ??
    run.request ??
    update ??
    summary ??
    (run.status === null ? undefined : RUN_STATUS_TEXT[run.status]) ??
    TASK_STATUS_TEXT[chip.status] ??
    "Working";
  const flat = text.replace(/\s+/gu, " ").trim();
  const state = needed?.state ?? (needed === null && run.request !== null ? "waiting" : undefined);
  const wait: GoatBotWaitKind | undefined =
    state === "paused"
      ? "usage_limit"
      : state === "waiting"
        ? "you"
        : update === null && summary === null && run.status === "waiting"
          ? "other_work"
          : undefined;
  return {
    state: "working",
    text: clip(flat),
    ...(flat.length > ACTIVITY_TEXT_LIMIT ? { fullText: flat } : {}),
    ...(state === undefined ? {} : { attention: state }),
    ...(wait === undefined ? {} : { wait }),
  };
}

/** What says whether a task waits on the person: a chip, or a list row with its chip's needs. */
export interface GoatBotTaskNeeds {
  readonly status: ChannelTaskChip["status"];
  readonly openQuestionCount: number;
  readonly observed?: ChannelTaskChip["observed"] | undefined;
}

function attention(
  chip: GoatBotTaskNeeds,
): { readonly text: string; readonly state: "waiting" | "paused" } | null {
  const needsYou = chip.observed?.needsYou ?? [];
  const has = (kind: (typeof needsYou)[number]["kind"]) =>
    needsYou.some((item) => item.kind === kind);
  const waiting = (text: string) => ({ text, state: "waiting" as const });
  if (has("approval")) return waiting("Waiting for your approval");
  if (chip.openQuestionCount > 0 || has("question")) return waiting("Waiting for your answer");
  if (has("sign_in")) return waiting("Waiting for you to sign in");
  if (has("usage_limit") || chip.observed?.usageLimitResetAt !== undefined) {
    return { text: "Paused on a usage limit", state: "paused" };
  }
  return chip.status === "waiting_input" ? waiting("Waiting for you") : null;
}

/**
 * What a task waits on the person for, in the activity line's words, or null. Going work waits on
 * anything it asks; finished or failed work only on an approval still open. The face, Home's Work
 * and Machines read this, so none of them calls a waiting task working.
 */
export function goatBotTaskWait(task: GoatBotTaskNeeds): string | null {
  if (OUTSTANDING.has(task.status)) return attention(task)?.text ?? null;
  return (task.status === "completed" || task.status === "failed") &&
    task.observed?.needsYou.some((item) => item.kind === "approval") === true
    ? "Waiting for your approval"
    : null;
}

export function goatBotTaskWaitsOnPerson(task: GoatBotTaskNeeds): boolean {
  return goatBotTaskWait(task) !== null;
}

/** The newest chip of each task in a conversation, the record its cards and face read. */
export function goatBotNewestTaskChips(
  items: ReadonlyArray<Pick<OrchestrationV2ProjectedTurnItem, "item">>,
): ReadonlyMap<ChannelTaskChip["taskId"], ChannelTaskChip> {
  const chips = new Map<ChannelTaskChip["taskId"], ChannelTaskChip>();
  for (const { item } of items) {
    if (item.type !== "notification" || item.ledgerTask === undefined) continue;
    const previous = chips.get(item.ledgerTask.taskId);
    if (previous === undefined || item.ledgerTask.taskVersion > previous.taskVersion)
      chips.set(item.ledgerTask.taskId, item.ledgerTask);
  }
  return chips;
}

function requestText(kind: string, blocking: boolean | undefined): string | null {
  if (blocking === false || kind === "dynamic_tool_call") return null;
  if (kind === "user_input") return "Waiting for your answer";
  if (kind === "auth_refresh") return "Waiting for you to sign in";
  return "Waiting for your approval";
}

interface RunEvidence {
  readonly status: string | null;
  readonly request: string | null;
}

const NO_EVIDENCE: RunEvidence = { status: null, request: null };

/**
 * A dedicated worker (no run id, not a session thread) is the task's own thread, so its shell
 * describes the task. A shared thread counts only through resident records that name the task's
 * run; the shell's run fields may already describe another task's run.
 */
function runEvidence(
  chip: ChannelTaskChip,
  observation: GoatBotWorkerObservation | null,
): RunEvidence {
  const worker = chip.worker;
  // Thread keys carry no host, so a lookup could find a different machine's thread.
  if (worker === undefined || worker.host !== undefined || observation === null) return NO_EVIDENCE;
  const { shell, projection } = observation;
  const runId = worker.runId;
  if (runId === undefined) {
    if (isGoatBotSessionThreadId(worker.threadId)) return NO_EVIDENCE;
    const request = shell?.pendingRuntimeRequest ?? null;
    return {
      status:
        shell?.activityRunStatus === "starting" && shell.latestRunStartHeld
          ? "waiting"
          : (shell?.activityRunStatus ?? null),
      request: request === null ? null : requestText(request.kind, request.blocking),
    };
  }
  if (projection === null) return NO_EVIDENCE;
  const run = projection.runs.find((entry) => entry.id === runId);
  if (run === undefined) return NO_EVIDENCE;
  const runOfNode = new Map(projection.nodes.map((node) => [node.id, node.runId] as const));
  const request = projection.runtimeRequests.findLast(
    (entry) => entry.status === "pending" && runOfNode.get(entry.nodeId) === runId,
  );
  return {
    status: run.status === "starting" && run.startHold !== undefined ? "waiting" : run.status,
    request: request === undefined ? null : requestText(request.kind, undefined),
  };
}

function clip(flat: string): string {
  return flat.length <= ACTIVITY_TEXT_LIMIT ? flat : flat.slice(0, ACTIVITY_TEXT_LIMIT - 1) + "…";
}

const RELEASE_CHECK_MS = 5_000;
const peekListeners = new WeakMap<AtomRegistry.Node<unknown>, number>();

function observedByOthers(node: AtomRegistry.Node<unknown>): boolean {
  return node.listeners.size - (peekListeners.get(node) ?? 0) + node.children.size > 0;
}

function residentNode<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>) {
  const node = registry.getNodes().get(atom) as AtomRegistry.Node<A> | undefined;
  return node !== undefined && observedByOthers(node) ? node : null;
}

/** The value of an atom another view keeps loaded, or null. Never creates or loads the atom. */
export function residentAtomValue<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
): A | null {
  const node = residentNode(registry, atom);
  return node === null ? null : Option.getOrNull(node.valueOption());
}

/**
 * Hears changes to an atom only while another view keeps it loaded. Listening alone would keep the
 * stream open after that view leaves, so the listener lets go within RELEASE_CHECK_MS of the last
 * other observer leaving.
 */
export function observeResidentAtom<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  onChange: () => void,
): () => void {
  const node = residentNode(registry, atom);
  if (node === null) return () => {};
  let remove: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const release = () => {
    if (remove === null) return;
    clearInterval(timer);
    remove();
    remove = null;
    const count = (peekListeners.get(node) ?? 1) - 1;
    if (count > 0) peekListeners.set(node, count);
    else peekListeners.delete(node);
    if (node.canBeRemoved) registry.scheduleNodeRemoval(node);
  };
  const check = () => {
    if (observedByOthers(node)) return false;
    release();
    onChange();
    return true;
  };
  remove = node.subscribe(() => {
    if (!check()) onChange();
  });
  peekListeners.set(node, (peekListeners.get(node) ?? 0) + 1);
  // @effect-diagnostics-next-line globalTimers:off - React subscriptions run outside an Effect runtime.
  timer = setInterval(check, RELEASE_CHECK_MS);
  return release;
}
