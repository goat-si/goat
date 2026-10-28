import {
  isGoatBotSessionThreadId,
  type ChannelTaskChip,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { GoatBotItemReaders } from "./rows.ts";

/**
 * What GOAT Bot's "..." says: reading the newest message, or the step of the work it acknowledged.
 * Task observations always count. Worker thread activity counts only when it provably belongs to
 * the task's run, because a GOAT Bot session thread serves several tasks one run at a time.
 */
export interface GoatBotActivity {
  readonly state: "reading" | "working";
  readonly text: string;
}

/** The task the working indicator follows and its newest update in the conversation. */
export interface GoatBotActivityTask {
  readonly chip: ChannelTaskChip;
  readonly update: GoatBotStep | null;
}

interface GoatBotStep {
  readonly text: string;
  readonly at: number;
}

type StepItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "status" | "title" | "updatedAt">;

/** What this client already holds for a worker thread. Nothing is loaded for the indicator. */
export interface GoatBotWorkerObservation {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "pendingRuntimeRequest"
  > | null;
  readonly projection: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
    readonly nodes: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "id" | "runId">>;
    readonly runtimeRequests: ReadonlyArray<
      Pick<OrchestrationV2RuntimeRequest, "nodeId" | "kind" | "status">
    >;
    readonly turnItems: ReadonlyArray<StepItem>;
  } | null;
}

export const GOAT_BOT_READING_TEXT = "Reading your message";
const ACTIVITY_TEXT_LIMIT = 120;
const OUTSTANDING: ReadonlySet<ChannelTaskChip["status"]> = new Set([
  "received",
  "dispatching",
  "running",
  "waiting_input",
]);
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
const NOT_STEPS: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "notification",
]);

const timeOf = (item: Pick<OrchestrationV2TurnItem, "updatedAt">) =>
  DateTime.toEpochMillis(item.updatedAt);

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
  const updates = new Map<string, GoatBotStep>();
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
      updates.set(taskId, { text: item.text, at: timeOf(item) });
    }
  });
  let newest: { readonly chip: ChannelTaskChip; readonly index: number } | null = null;
  for (const [taskId, index] of acknowledged) {
    const chip = chips.get(taskId);
    if (chip === undefined || !OUTSTANDING.has(chip.status)) continue;
    if (newest === null || index > newest.index) newest = { chip, index };
  }
  if (newest === null) return null;
  return { chip: newest.chip, update: updates.get(newest.chip.taskId) ?? null };
}

/** Reading wins; otherwise the followed task's most specific step. */
export function goatBotActivity(input: {
  readonly reading: boolean;
  readonly task: GoatBotActivityTask | null;
  readonly worker: GoatBotWorkerObservation | null;
}): GoatBotActivity | null {
  if (input.reading) return { state: "reading", text: GOAT_BOT_READING_TEXT };
  if (input.task === null) return null;
  const { chip, update } = input.task;
  const run = runEvidence(chip, input.worker);
  const step =
    update !== null && run.step !== null
      ? run.step.at > update.at
        ? run.step
        : update
      : (update ?? run.step);
  const summary = chip.summary?.trim() ? chip.summary : null;
  const text =
    attentionText(chip) ??
    run.request ??
    step?.text ??
    summary ??
    (run.status === null ? undefined : RUN_STATUS_TEXT[run.status]) ??
    TASK_STATUS_TEXT[chip.status] ??
    "Working";
  return { state: "working", text: clip(text) };
}

function attentionText(chip: ChannelTaskChip): string | null {
  const needsYou = chip.observed?.needsYou ?? [];
  const has = (kind: (typeof needsYou)[number]["kind"]) =>
    needsYou.some((item) => item.kind === kind);
  if (has("approval")) return "Waiting for your approval";
  if (chip.openQuestionCount > 0 || has("question")) return "Waiting for your answer";
  if (has("sign_in")) return "Waiting for you to sign in";
  if (has("usage_limit") || chip.observed?.usageLimitResetAt !== undefined) {
    return "Paused on a usage limit";
  }
  return chip.status === "waiting_input" ? "Waiting for you" : null;
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
  readonly step: GoatBotStep | null;
}

const NO_EVIDENCE: RunEvidence = { status: null, request: null, step: null };

/**
 * A dedicated worker (no run id, not a session thread) is the task's own thread, so its shell and
 * resident items describe the task. A shared thread counts only through resident records that name
 * the task's run; the shell's run fields may already describe another task's run.
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
      status: shell?.activityRunStatus ?? null,
      request: request === null ? null : requestText(request.kind, request.blocking),
      step: projection === null ? null : currentStep(projection.turnItems, null),
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
    status: run.status,
    request: request === undefined ? null : requestText(request.kind, undefined),
    step: currentStep(projection.turnItems, runId),
  };
}

function currentStep(items: ReadonlyArray<StepItem>, runId: string | null): GoatBotStep | null {
  const item = items.findLast(
    (entry) =>
      !NOT_STEPS.has(entry.type) &&
      (entry.status === "pending" || entry.status === "running" || entry.status === "waiting") &&
      (runId === null || entry.runId === runId) &&
      (entry.title ?? "").trim() !== "",
  );
  return item === undefined ? null : { text: item.title ?? "", at: timeOf(item) };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
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
  timer = setInterval(check, RELEASE_CHECK_MS);
  return release;
}
