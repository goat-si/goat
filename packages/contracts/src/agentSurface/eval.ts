import * as Schema from "effect/Schema";

import {
  AgentSurfaceError,
  AgentSurfaceHandoff,
  AgentSurfaceMeta,
  AgentSurfaceNextCall,
} from "./envelope.ts";
import { OperationRef } from "./operation.ts";

/** Fixed bounds of one goat_eval run (docs/internals/agent-surface.md#composition-goat_eval). */
export const EVAL_LIMITS = {
  /** UTF-8 bytes of the program text, or of the JSON program as sent. */
  programBytes: 16_384,
  /** Nesting of lists, vectors and maps. */
  depth: 8,
  /** Calls one run may make, journal restores included. */
  calls: 32,
  /** Elements one map may visit. */
  mapWidth: 16,
  /** JSON bytes of every step result plus the final value. */
  resultBytes: 262_144,
  timeoutMs: 120_000,
} as const;

/**
 * The language, served as goat_eval's guide. Kept beside the schema so the contract and its
 * description cannot drift; the registration that serves it lands separately.
 * @public
 */
export const EVAL_GUIDE = [
  "A program is one S-expression, as text or as the same tree in JSON arrays.",
  'Text: (thread.read :threadId "t1"), lists in (), vectors in [], maps in {"k" v :k2 v2}, strings with JSON escapes, numbers, true/false/null, :keywords, symbols, \'x for (quote x), ; comments.',
  'JSON: ["thread.read", {"threadId": "t1"}]. An array is a form named by its first string; objects are maps whose values are expressions; other strings are literals; ["var", "x"] reads a variable; ["quote", v] keeps v literal.',
  "Calls: (resource.verb :key val ...), (resource.verb {map}) or (call resource.verb {map}). A call runs as goat_call would, and an ok result evaluates to its value. Programs may not pass clientRequestId: each write's key is derived from the run and the step.",
  "Forms: (let ((name expr) ...) body ...) binds in order; (. x key ...) or (get x key ...) follows keys or indexes, null when missing; (pick x key ...) keeps only those keys, element by element on an array; (map name coll body) runs body per element, at most 16; (filter name coll pred) keeps elements whose pred is true, and pred may not call anything; (if c a b); (eq a b); (not x); (seq e ...) returns every value; (try e) returns e's envelope instead of stopping; (quote x); (list e ...) or [e ...]; (var name). false and null are false.",
  "An error stops the run unless try wraps the call. needs_human, unknown_outcome and limits stop it even inside try.",
  "Limits: 16 KiB program, depth 8, 32 calls, 16 map elements, 256 KiB of results, 120 s.",
  "Pass the same clientRequestId, or resume with the evalRunId a halted run returned, to continue: completed steps come from the run's journal and are not called again. A run that stopped at needs_human returns its handoff's state on resume; put the remaining work in a new program.",
].join("\n");

const RunId = Schema.String.annotate({
  description: "The run's id. Pass it as resume to continue a halted run.",
});

export const EvalProgram = Schema.Union([
  Schema.String.annotate({
    description: 'S-expression text, such as (thread.read :threadId "t1").',
  }),
  Schema.Array(Schema.Unknown).annotate({
    description: 'The program as JSON arrays, such as ["thread.read", {"threadId": "t1"}].',
  }),
]);
export type EvalProgram = typeof EvalProgram.Type;

export const EvalInput = Schema.Struct({
  program: Schema.optionalKey(EvalProgram).annotate({
    description: "The program to run. Required unless resume names a run.",
  }),
  bindings: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Variables the program can read by name, such as ids to visit.",
    }),
  ),
  clientRequestId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description:
        "Names this run. A retry with the same key and program continues it from its journal instead of running completed steps again.",
    }),
  ),
  resume: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
      description: "evalRunId of a halted run to continue. Omit program, or send the same one.",
    }),
  ),
  dryRun: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Check the program and return {plan} without calling anything: each call site's path, effect, availability and refused argument names.",
    }),
  ),
});
export type EvalInput = typeof EvalInput.Type;

/** A step the run finished, named by its coordinate in the program. */
export const EvalStepRef = Schema.Struct({ step: Schema.String, path: Schema.String });
export type EvalStepRef = typeof EvalStepRef.Type;

/** Work a step started that is still running; unwrapping a value never hides it. */
export const EvalOperation = Schema.Struct({
  step: Schema.String,
  path: Schema.String,
  operation: OperationRef,
});
export type EvalOperation = typeof EvalOperation.Type;

export const EvalPlanCall = Schema.Struct({
  step: Schema.String,
  path: Schema.String,
  name: Schema.String,
  effect: Schema.Literals(["read", "write", "destructive"]),
  /** GOAT derives a clientRequestId for this write, so a retry cannot run it twice. */
  keyed: Schema.Boolean,
  available: Schema.Struct({ now: Schema.Boolean, reason: Schema.optionalKey(Schema.String) }),
  /** static: every argument is known before the run; dynamic: some come from earlier steps. */
  args: Schema.Literals(["static", "dynamic"]),
  argIssues: Schema.Array(Schema.String),
});
export type EvalPlanCall = typeof EvalPlanCall.Type;

export const EvalPlan = Schema.Struct({
  calls: Schema.Array(EvalPlanCall),
  /** The most calls the program can make, counting each map at its full width. */
  maxCalls: Schema.Int,
});
export type EvalPlan = typeof EvalPlan.Type;

const RunFields = {
  evalRunId: RunId,
  /** Every result lists the operation handles its steps returned. */
  operations: Schema.Array(EvalOperation),
};
const HaltFields = {
  ...RunFields,
  /** The step that stopped the run, or "run" when it stopped between steps. */
  haltedAt: Schema.String,
  completedSteps: Schema.Array(EvalStepRef),
};

export const EvalResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    value: Schema.Unknown,
    ...RunFields,
    steps: Schema.Struct({ live: Schema.Int, restored: Schema.Int }),
    meta: Schema.optionalKey(AgentSurfaceMeta),
  }),
  /** dryRun: the plan only; nothing ran and no run exists. */
  Schema.Struct({ status: Schema.Literal("ok"), value: Schema.Struct({ plan: EvalPlan }) }),
  Schema.Struct({ status: Schema.Literal("error"), error: AgentSurfaceError, ...HaltFields }),
  /** Refused before a run existed: nothing ran. */
  Schema.Struct({ status: Schema.Literal("error"), error: AgentSurfaceError }),
  Schema.Struct({
    status: Schema.Literal("needs_human"),
    handoff: AgentSurfaceHandoff,
    next: Schema.optionalKey(AgentSurfaceNextCall),
    ...HaltFields,
  }),
]);
export type EvalResult = typeof EvalResult.Type;
