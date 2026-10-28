// @effect-diagnostics globalDate:off - a plain Node step of the eval runner; no Effect runtime.
/**
 * One eval run: observe, run the arm, observe again, score. The effects come in as deps, so the
 * runner's own path is testable without a screen; run.ts passes the real ones.
 */
import { answerInstruction, type JsonObject } from "../agent-surface/eval/core.ts";
import {
  type ArmSpec,
  COMMON_RULES,
  type Observations,
  type Sample,
  type Task,
  type Transcript,
  keepObservations,
  scoreRun,
} from "./core.ts";
import type { Witness } from "./macos.ts";
import type { RunRow } from "./report.ts";

/** Cleanup that could not be confirmed: the next run would share the screen with a live agent. */
export class HaltError extends Error {}

export interface Ran {
  readonly transcript: Transcript;
  readonly wallMs: number | null;
  readonly ref: string;
  readonly notes: ReadonlyArray<string>;
}

export interface Leftovers {
  readonly left: ReadonlyArray<string>;
  readonly unobserved: boolean;
  readonly notes: ReadonlyArray<string>;
}

export interface StepDeps<Snapshot> {
  /** The runner's shared state: the signal handler stops whatever observer is registered here. */
  readonly active: { observer: { readonly stop: () => Promise<unknown> } | null };
  readonly witnessFor: (task: Task) => Witness | null;
  readonly readWitness: (witness: Witness) => Promise<JsonObject>;
  readonly sampleUntil: (witness: Witness) => {
    readonly stop: () => Promise<ReadonlyArray<Sample>>;
  };
  readonly documentsSince: (sinceMs: number) => ReadonlyArray<string>;
  readonly snapshot: (arm: ArmSpec, task: Task) => Promise<Snapshot>;
  readonly leftoversOf: (
    arm: ArmSpec,
    task: Task,
    before: Snapshot,
    after: Snapshot,
    final: JsonObject,
  ) => Promise<Leftovers>;
  readonly runAgent: (task: Task, arm: ArmSpec, prompt: string) => Promise<Ran>;
}

export const EMPTY_ROW = {
  contended: false,
  error: null,
  claimed: null,
  answerError: null,
  actual: null,
  outcome: null,
  misreport: null,
  valueErrors: [],
  violations: [],
  leftovers: [],
  notes: [],
  metrics: null,
  tokens: null,
  wallMs: null,
  ref: null,
} as const;

const promptFor = (task: Task, arm: ArmSpec) =>
  task.prompt +
  "\n\n" +
  arm.instruction +
  "\n" +
  COMMON_RULES +
  answerInstruction(task.answerKeys) +
  ' The status value is "done", "failed" or "skipped".';

/** The final read; a failed witness read is kept as one, and the saved-file scan still runs. */
const finalObservation = async (
  read: (() => Promise<JsonObject>) | null,
  savedFiles: (() => ReadonlyArray<string>) | null,
): Promise<JsonObject> => {
  if (read === null) return {};
  let value: JsonObject;
  try {
    value = await read();
  } catch (error) {
    value = { witnessError: String(error) };
  }
  return savedFiles === null ? value : { ...value, savedFiles: [...savedFiles()] };
};

export const runStep = async <Snapshot>(
  task: Task,
  arm: ArmSpec,
  base: Omit<RunRow, "task" | "surface" | "arm" | "at" | "status">,
  deps: StepDeps<Snapshot>,
): Promise<RunRow> => {
  const head = {
    ...base,
    task: task.id,
    surface: task.surface,
    arm: arm.id,
    at: new Date().toISOString(),
  };
  if (!arm.surfaces.includes(task.surface))
    return {
      ...head,
      status: "unsupported",
      error: arm.id + " has no " + task.surface + " surface",
    };
  const witness = deps.witnessFor(task);
  const read = witness === null ? null : () => deps.readWitness(witness);
  const before = await deps.snapshot(arm, task);
  const baseline = read === null ? {} : await read();
  const sampler = witness === null ? null : deps.sampleUntil(witness);
  deps.active.observer = sampler;
  const startedMs = Date.now();
  let ran: Ran;
  try {
    ran = await deps.runAgent(task, arm, promptFor(task, arm));
  } catch (error) {
    await sampler?.stop();
    deps.active.observer = null;
    if (error instanceof HaltError) throw error;
    const after = await deps.snapshot(arm, task).catch(() => null);
    const left = after === null ? null : await deps.leftoversOf(arm, task, before, after, {});
    return {
      ...head,
      status: "error",
      error: String(error),
      leftovers: left?.left ?? [],
      cleanupUnobserved: left?.unobserved ?? true,
      notes: after === null ? ["the end of the run could not be observed"] : [],
    };
  }
  const samples = (await sampler?.stop()) ?? [];
  deps.active.observer = null;
  const final = await finalObservation(
    read,
    task.oracle === "textEditDiscard" ? () => deps.documentsSince(startedMs) : null,
  );
  const after = await deps.snapshot(arm, task);
  const observed: Observations = {
    baseline,
    samples,
    final,
    toolOutputs: ran.transcript.steps
      .filter((step) => step.kind === "tool")
      .map((step) => step.output),
    steps: ran.transcript.steps,
    finalText: ran.transcript.finalText,
    notes: ran.notes,
    truncated: ran.transcript.incomplete,
  };
  const leftovers = await deps.leftoversOf(arm, task, before, after, final);
  const scored = scoreRun(task, arm, {
    ...observed,
    notes: [...observed.notes, ...leftovers.notes],
  });
  return {
    ...head,
    status: "ran",
    ...scored,
    leftovers: leftovers.left,
    cleanupUnobserved: leftovers.unobserved,
    tokens: ran.transcript.tokens,
    wallMs: ran.wallMs,
    ref: ran.ref,
    // Scored from the full observations; the row keeps a cut copy that is marked when cut.
    observations: keepObservations({ ...observed, notes: [...observed.notes, ...leftovers.notes] }),
  };
};
