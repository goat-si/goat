/**
 * Rules for the D8 measurement campaigns (docs/operations/agent-surface-eval.md): the goat_eval
 * gate, and the listing comparison that tunes the resident core.
 * Nothing here touches a server, the clock, or the filesystem, so the rules that decide a
 * verdict are tested apart from the runs they judge.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export type Claim = "reduces" | "no_gain";
/** Which question a campaign answers; each has its own verdict rule (see summarizeTask). */
export type GateKind = "eval" | "listing";

export interface Task {
  readonly id: string;
  readonly claim: Claim;
  readonly falsifiedIf: string;
  readonly manual: boolean;
  readonly needs: ReadonlyArray<string>;
  readonly fixture: { readonly kind: string } & JsonObject;
  readonly prompt: string;
  readonly answerKeys: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly deadlineMs: number;
}

export interface TaskSet {
  readonly version: number;
  readonly tasks: ReadonlyArray<Task>;
}

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
}

/** Tools every core listing serves. */
export const CORE_TOOLS: ReadonlyArray<string> = ["goat_describe", "goat_call"];

/**
 * What tools/list serves the arm's provider instance. The runner cannot set it: the arm's
 * instance is configured for it, and a call outside it marks the run contaminated.
 */
export type Listing =
  | { readonly mode: "full" }
  | { readonly mode: "core"; readonly resident: ReadonlyArray<string> };

export interface Arm {
  readonly id: string;
  readonly modelSelection: ModelSelection;
  readonly forbidTools: ReadonlyArray<string>;
  readonly forbidItemTypes: ReadonlyArray<string>;
  readonly listing: Listing | null;
}

export interface Campaign {
  readonly gate: GateKind;
  readonly taskSetVersion: number;
  readonly projectId: string;
  readonly pairs: number;
  readonly baselineArm: string;
  /** Null for a baseline-only campaign, which records numbers and reaches no verdict. */
  readonly candidateArm: string | null;
  readonly arms: readonly [Arm] | readonly [Arm, Arm];
  /**
   * The eval server's settings.json. When set, the runner writes each run's agentToolListing
   * there before launching it; either way it checks tools/list against the arm.
   */
  readonly listingSettings: string | null;
  readonly fixtureModel: ModelSelection;
  readonly reviewModels: ReadonlyArray<ModelSelection>;
  readonly values: Readonly<Record<string, string>>;
}

export interface Implemented {
  readonly fixtures: ReadonlySet<string>;
  readonly checks: ReadonlySet<string>;
}

export class CampaignError extends Error {}

/** The fewest successful clean runs per arm and task before a median means anything. */
export const MIN_CLEAN_RUNS = 10;
/** D8: the candidate must need at least a third fewer model turns. */
export const REQUIRED_TURN_RATIO = 2 / 3;
/** Context diet: a single-call control may cost at most one more model turn. */
export const CONTROL_TURN_ALLOWANCE = 1;
/** Placeholders the runner fills on every run; tasks may also use campaign values and fixture.* */
const RUN_VARIABLES = ["projectId", "tag", "reviewModels", "fixtureModel"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isTextList = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isText);
const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const modelSelection = (value: unknown, where: string): ModelSelection => {
  if (!isObject(value) || !isText(value["instanceId"]) || !isText(value["model"]))
    throw new CampaignError(where + " needs instanceId and model");
  return { instanceId: value["instanceId"], model: value["model"] };
};

const listing = (value: unknown, where: string): Listing | null => {
  if (value === undefined) return null;
  if (isObject(value) && value["mode"] === "full") return { mode: "full" };
  const resident = isObject(value) ? (value["resident"] ?? []) : null;
  if (isObject(value) && value["mode"] === "core" && isTextList(resident))
    return { mode: "core", resident };
  throw new CampaignError(where + ': listing is { mode: "full" } or { mode: "core", resident }');
};

const placeholders = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((match) => match[1]!);

/** A placeholder with no value is an error: an empty string would send a different prompt. */
export const render = (template: string, vars: Readonly<Record<string, string>>) =>
  template.replace(/\{\{([\w.]+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new CampaignError("no value for {{" + name + "}}");
    return value;
  });

/** Appended to every prompt in both arms, so the answer contract never differs between them. */
export const answerInstruction = (keys: ReadonlyArray<string>) =>
  "\n\nWhen you are done, end your reply with exactly one line that starts with EVAL_JSON " +
  "followed by a JSON object with the keys " +
  keys.join(", ") +
  ".";

/** Checks a manual task names that the runner cannot evaluate yet. */
export const pendingChecks = (task: Task, implemented: Implemented) =>
  task.checks.filter((check) => !implemented.checks.has(check));

export const validateTaskSet = (raw: unknown, implemented: Implemented): TaskSet => {
  if (!isObject(raw) || !isPositiveInt(raw["version"]) || !Array.isArray(raw["tasks"]))
    throw new CampaignError("a task set is { version, tasks: [...] }");
  const tasks = raw["tasks"].map((value: unknown, index): Task => {
    if (!isObject(value) || !isText(value["id"]))
      throw new CampaignError("task " + index + " needs an id");
    const id = value["id"];
    const claim = value["claim"];
    if (claim !== "reduces" && claim !== "no_gain")
      throw new CampaignError(id + ": claim must be reduces or no_gain");
    if (!isText(value["falsifiedIf"]))
      throw new CampaignError(id + ": state what would falsify the claim");
    const manual = value["manual"] === true;
    const needs = value["needs"] ?? [];
    if (!isTextList(needs) || (manual && needs.length === 0))
      throw new CampaignError(id + ": a manual task lists what it needs");
    const fixture = value["fixture"];
    if (
      !isObject(fixture) ||
      !isText(fixture["kind"]) ||
      !implemented.fixtures.has(fixture["kind"])
    )
      throw new CampaignError(id + ": unknown fixture " + JSON.stringify(fixture));
    if (!isText(value["prompt"])) throw new CampaignError(id + ": no prompt");
    const answerKeys = value["answerKeys"];
    if (!isTextList(answerKeys) || answerKeys.length === 0)
      throw new CampaignError(id + ": answerKeys must name what a correct answer reports");
    const checks = value["checks"];
    // Reaching the end of a transcript is not correctness, so every task needs an oracle.
    if (!isTextList(checks) || checks.length === 0)
      throw new CampaignError(id + ": every task needs at least one check");
    const deadlineMs = value["deadlineMs"];
    if (!isPositiveInt(deadlineMs)) throw new CampaignError(id + ": deadlineMs must be positive");
    const task: Task = {
      id,
      claim,
      falsifiedIf: value["falsifiedIf"],
      manual,
      needs,
      fixture: fixture as Task["fixture"],
      prompt: value["prompt"],
      answerKeys,
      checks,
      deadlineMs,
    };
    // An automatic task judged only by the checks that happen to exist would pass by omission.
    const pending = pendingChecks(task, implemented);
    if (!manual && pending.length > 0)
      throw new CampaignError(id + ": no implementation for " + pending.join(", "));
    return task;
  });
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new CampaignError("task ids must be unique");
  // Without a control the report cannot tell a measurement artifact from a real gain.
  const claims = new Set(tasks.map((task) => task.claim));
  if (!claims.has("no_gain") || !claims.has("reduces"))
    throw new CampaignError("a task set needs a no_gain control and at least one reduces task");
  return { version: raw["version"], tasks };
};

export const validateCampaign = (
  raw: unknown,
  taskSet: TaskSet,
  selected: ReadonlyArray<Task>,
): Campaign => {
  if (!isObject(raw)) throw new CampaignError("a campaign is a JSON object");
  if (raw["taskSetVersion"] !== taskSet.version)
    throw new CampaignError(
      "campaign is for task set " +
        String(raw["taskSetVersion"]) +
        ", the set is " +
        taskSet.version,
    );
  if (!isText(raw["projectId"])) throw new CampaignError("campaign needs a projectId");
  if (!isPositiveInt(raw["pairs"])) throw new CampaignError("pairs must be a positive integer");
  const gateKind = raw["gate"] ?? "eval";
  if (gateKind !== "eval" && gateKind !== "listing")
    throw new CampaignError("gate is eval or listing");
  const rawArms = raw["arms"];
  if (!Array.isArray(rawArms) || rawArms.length < 1 || rawArms.length > 2)
    throw new CampaignError("a campaign runs one baseline arm or compares two arms");
  const arms = rawArms.map((value: unknown, index): Arm => {
    if (!isObject(value) || !isText(value["id"]))
      throw new CampaignError("arm " + index + " needs an id");
    const forbidTools = value["forbidTools"] ?? [];
    const forbidItemTypes = value["forbidItemTypes"] ?? [];
    if (!isTextList(forbidTools) || !isTextList(forbidItemTypes))
      throw new CampaignError(value["id"] + ": forbidTools and forbidItemTypes are string lists");
    const arm: Arm = {
      id: value["id"],
      modelSelection: modelSelection(value["modelSelection"], "arm " + value["id"]),
      forbidTools,
      forbidItemTypes,
      listing: listing(value["listing"], "arm " + value["id"]),
    };
    // A listing campaign whose arm does not say what it lists cannot detect a misconfigured one.
    if (gateKind === "listing" && arm.listing === null)
      throw new CampaignError(arm.id + ": a listing campaign states each arm's listing");
    return arm;
  });
  const armIds = arms.map((arm) => arm.id);
  if (new Set(armIds).size !== armIds.length)
    throw new CampaignError("the two arms need different ids");
  const baselineArm = raw["baselineArm"];
  const candidateArm = raw["candidateArm"] ?? null;
  if (
    !isText(baselineArm) ||
    !armIds.includes(baselineArm) ||
    (arms.length === 1
      ? candidateArm !== null
      : !isText(candidateArm) || baselineArm === candidateArm || !armIds.includes(candidateArm))
  )
    throw new CampaignError(
      "baselineArm names the baseline arm, and candidateArm the other arm when there are two",
    );
  const values = raw["values"] ?? {};
  if (!isObject(values) || !Object.values(values).every((value) => typeof value === "string"))
    throw new CampaignError("values maps placeholder names to strings");
  const listingSettings = raw["listingSettings"] ?? null;
  if (listingSettings !== null && !isText(listingSettings))
    throw new CampaignError("listingSettings is the eval server's settings.json path");
  const reviewModels = Array.isArray(raw["reviewModels"])
    ? raw["reviewModels"].map((value: unknown, index) =>
        modelSelection(value, "reviewModels[" + index + "]"),
      )
    : [];
  const known = new Set<string>([...RUN_VARIABLES, ...Object.keys(values)]);
  for (const task of selected) {
    const names = placeholders(task.prompt);
    const missing = names.filter((name) => !name.startsWith("fixture.") && !known.has(name));
    if (missing.length > 0)
      throw new CampaignError(task.id + ": the campaign has no value for " + missing.join(", "));
    if (names.includes("reviewModels") && reviewModels.length === 0)
      throw new CampaignError(task.id + ": the campaign lists no reviewModels");
  }
  return {
    gate: gateKind,
    taskSetVersion: taskSet.version,
    projectId: raw["projectId"],
    pairs: raw["pairs"],
    baselineArm,
    candidateArm: isText(candidateArm) ? candidateArm : null,
    arms: arms as [Arm] | [Arm, Arm],
    listingSettings,
    fixtureModel: modelSelection(raw["fixtureModel"], "fixtureModel"),
    reviewModels,
    values: values as Record<string, string>,
  };
};

export interface Step {
  readonly taskId: string;
  readonly pair: number;
  readonly slot: number;
  readonly armId: string;
}

/**
 * ABBA, derived from the pair index rather than a seed: a run that goes second inherits the
 * server state the first one left, so the order alternates and two campaigns share a schedule.
 */
export const schedule = (tasks: ReadonlyArray<Task>, campaign: Campaign): ReadonlyArray<Step> =>
  tasks.flatMap((task) =>
    Array.from({ length: campaign.pairs }, (_, pair) => {
      const [a, b] = campaign.arms;
      const order = b === undefined ? [a] : pair % 2 === 0 ? [a, b] : [b, a];
      return order.map((arm, slot) => ({
        taskId: task.id,
        pair,
        slot,
        armId: arm.id,
      }));
    }).flat(),
  );

export interface TimelineItem {
  readonly itemId: string;
  readonly type: string;
  readonly status: string;
  readonly text: string | null;
  readonly textTruncated: boolean;
}

const TOOL_TYPES = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);
const TURN_BOUNDARY_TYPES = new Set(["assistant_message", "reasoning", "proposed_plan"]);
const HUMAN_TYPES = new Set([
  "approval_request",
  "user_input_request",
  "human_handoff",
  "secret_request",
]);
const OTHER_TYPES = new Set([
  "user_message",
  "todo_list",
  "checkpoint",
  "system_notice",
  "notification",
  "compaction",
  "handoff",
  "fork",
  "run_interrupt_request",
  "run_interrupt_result",
  "error",
]);

// GOAT adds this item while it prepares the workspace, before the provider starts.
const isWorkspacePreparation = (item: TimelineItem) =>
  item.type === "command_execution" && item.itemId.includes(":native-item:workspace-preparation");

/** The activity view summarizes a dynamic tool as JSON whose first key is toolName. */
const toolNameOf = (item: TimelineItem): string | null =>
  /"toolName":\s*"([^"]+)"/.exec(item.text ?? "")?.[1] ?? null;

/** Codex names a GOAT tool goat.<tool>, Claude mcp__goat__<tool>; null for another server. */
export const goatToolOf = (name: string): string | null =>
  /^(?:goat\.|mcp__goat__)(.+)$/.exec(name)?.[1] ?? null;

const namesTool = (name: string, tool: string) =>
  name === tool || name.endsWith("." + tool) || name.endsWith("__" + tool);

/**
 * Whether a reported model names the run's model. Prompts list models as "<instance> / <model>",
 * so agents report that, "<instance>/<model>", or the bare id; a model id may itself hold "/".
 */
export const sameModel = (
  reported: string,
  ran: { readonly instanceId: string; readonly model: string },
) =>
  [ran.model, ran.instanceId + " / " + ran.model, ran.instanceId + "/" + ran.model].includes(
    reported.trim(),
  );

/** Why a tool call failed, so a search miss can be told from a rejected argument. */
export interface FailedCall {
  readonly tool: string;
  readonly code: string | null;
  readonly reason: string;
}

// A failed result is the server's error JSON, often escaped inside the item's text.
const failedCallOf = (item: TimelineItem): FailedCall => {
  // Only the output: the call's own input can hold a "message" field too.
  let text = item.text ?? "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && "output" in parsed) text = JSON.stringify(parsed["output"]) ?? "";
  } catch {
    // A truncated or plain-text item is read as it is.
  }
  const code = /\\?"code\\?":\s*\\?"([\w.-]+)/.exec(text)?.[1] ?? null;
  const message = /\\?"message\\?":\s*\\?"(.*?)\\?"\s*[,}]/.exec(text)?.[1] ?? null;
  return {
    tool: toolNameOf(item) ?? item.type,
    code,
    reason: (message ?? text).replace(/\s+/g, " ").slice(0, 240),
  };
};

/**
 * Bytes of the result the server returned, as compact JSON. The activity view pretty-prints the
 * call, so its length overstates the result. In code mode a script may keep the result out of
 * the transcript, so for Codex this is what was served, not what the model read.
 */
const resultBytesOf = (item: TimelineItem): number => {
  const text = item.text ?? "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && "output" in parsed)
      return Buffer.byteLength(JSON.stringify(parsed["output"]) ?? "", "utf8");
  } catch {
    // A truncated or plain-text item is measured as it is.
  }
  return Buffer.byteLength(text, "utf8");
};

export interface RunMetrics {
  readonly toolCalls: number;
  readonly toolRounds: number;
  /**
   * Model requests are not recorded per run. Calls made in one response arrive as consecutive
   * items, so tool rounds + 1 is a lower bound and tool calls + 1 an upper bound.
   */
  readonly modelTurns: { readonly min: number; readonly max: number };
  readonly failedToolCalls: number;
  readonly failedCalls: ReadonlyArray<FailedCall>;
  readonly subagents: number;
  readonly humanSteps: number;
  /** Bytes of tool results served to the run; a lower bound when an item text was truncated. */
  readonly resultBytes: number;
  readonly resultTruncated: boolean;
  readonly violations: ReadonlyArray<string>;
}

export const runMetrics = (items: ReadonlyArray<TimelineItem>, arm: Arm): RunMetrics => {
  let toolCalls = 0;
  let toolRounds = 0;
  let failedToolCalls = 0;
  const failedCalls: Array<FailedCall> = [];
  let subagents = 0;
  let humanSteps = 0;
  let resultBytes = 0;
  let resultTruncated = false;
  let inRound = false;
  const violations = new Set<string>();
  const listed =
    arm.listing?.mode === "core" ? new Set([...CORE_TOOLS, ...arm.listing.resident]) : null;
  for (const item of items) {
    if (isWorkspacePreparation(item)) continue;
    if (TOOL_TYPES.has(item.type)) {
      toolCalls += 1;
      if (!inRound) toolRounds += 1;
      inRound = true;
      if (item.status === "failed") {
        failedToolCalls += 1;
        failedCalls.push(failedCallOf(item));
      }
      resultBytes += resultBytesOf(item);
      resultTruncated ||= item.textTruncated;
      if (arm.forbidItemTypes.includes(item.type))
        violations.add(item.type + " is not available to arm " + arm.id);
      if (item.type === "dynamic_tool") {
        const name = toolNameOf(item);
        // Unreadable means unknown, and an unknown tool may be the forbidden one.
        if (name === null) violations.add("a tool call with no readable name");
        else if (arm.forbidTools.some((tool) => namesTool(name, tool)))
          violations.add(name + " is not available to arm " + arm.id);
        else {
          // A harness can only call what tools/list served, so an unlisted GOAT tool means the
          // arm's instance was not on the listing the arm claims.
          const goatTool = goatToolOf(name);
          if (listed !== null && goatTool !== null && !listed.has(goatTool))
            violations.add(name + " is not in arm " + arm.id + "'s core listing");
        }
      }
    } else if (TURN_BOUNDARY_TYPES.has(item.type)) {
      inRound = false;
    } else if (HUMAN_TYPES.has(item.type)) {
      humanSteps += 1;
      inRound = false;
    } else if (item.type === "subagent") {
      // The delegate_task call that started it is already a dynamic_tool item.
      subagents += 1;
    } else if (!OTHER_TYPES.has(item.type)) {
      // A new item kind would otherwise change the counts without anyone noticing.
      violations.add("unclassified item type " + item.type);
    }
  }
  return {
    toolCalls,
    toolRounds,
    modelTurns: { min: toolRounds + 1, max: toolCalls + 1 },
    failedToolCalls,
    failedCalls,
    subagents,
    humanSteps,
    resultBytes,
    resultTruncated,
    violations: [...violations],
  };
};

/** A run that took several runs of its thread to answer costs all of them. */
export const sumMetrics = (runs: ReadonlyArray<RunMetrics>): RunMetrics => ({
  toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
  toolRounds: runs.reduce((sum, run) => sum + run.toolRounds, 0),
  modelTurns: {
    min: runs.reduce((sum, run) => sum + run.modelTurns.min, 0),
    max: runs.reduce((sum, run) => sum + run.modelTurns.max, 0),
  },
  failedToolCalls: runs.reduce((sum, run) => sum + run.failedToolCalls, 0),
  failedCalls: runs.flatMap((run) => run.failedCalls),
  subagents: runs.reduce((sum, run) => sum + run.subagents, 0),
  humanSteps: runs.reduce((sum, run) => sum + run.humanSteps, 0),
  resultBytes: runs.reduce((sum, run) => sum + run.resultBytes, 0),
  resultTruncated: runs.some((run) => run.resultTruncated),
  violations: [...new Set(runs.flatMap((run) => run.violations))],
});

/**
 * Whether tools/list, as the runner's own client saw it, is the listing an arm states. A core
 * listing is exactly the core tools and the arm's residents; a full one holds every tool any
 * core arm of the campaign lists and more, so no core variant passes for it.
 */
export const listingMatches = (
  listing: Listing,
  listed: ReadonlyArray<string>,
  campaignResidents: ReadonlyArray<string>,
) => {
  const expected = new Set([
    ...CORE_TOOLS,
    ...(listing.mode === "core" ? listing.resident : campaignResidents),
  ]);
  const seen = new Set(listed);
  const holdsExpected = [...expected].every((name) => seen.has(name));
  return listing.mode === "core"
    ? holdsExpected && seen.size === expected.size
    : holdsExpected && seen.size > expected.size;
};

/**
 * The thread's next run to count: the earliest by ordinal not yet counted, so two runs that end
 * between two looks are both measured, in order.
 */
export const nextUncountedRun = (
  runs: ReadonlyArray<{ readonly runId: string; readonly ordinal: number }>,
  counted: ReadonlySet<string>,
): string | null =>
  runs.filter((run) => !counted.has(run.runId)).toSorted((a, b) => a.ordinal - b.ordinal)[0]
    ?.runId ?? null;

type Verdict<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly why: string };

export const extractAnswer = (
  finalText: string | null,
  keys: ReadonlyArray<string>,
): Verdict<JsonObject> => {
  const lines = (finalText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("EVAL_JSON "));
  if (lines.length !== 1)
    return { ok: false, why: lines.length + " EVAL_JSON lines in the final reply; expected 1" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!.slice("EVAL_JSON ".length));
  } catch {
    return { ok: false, why: "the EVAL_JSON line is not JSON" };
  }
  if (!isObject(parsed)) return { ok: false, why: "the answer is not a JSON object" };
  // Only undefined is missing: 0, false, and "" are answers.
  const missing = keys.filter((key) => parsed[key] === undefined);
  if (missing.length > 0) return { ok: false, why: "the answer has no " + missing.join(", ") };
  return { ok: true, value: parsed as JsonObject };
};

export interface RunRow {
  readonly kind: "run";
  readonly campaignId: string;
  readonly taskSetVersion: number;
  readonly task: string;
  readonly arm: string;
  /** What the arm ran on, so a row can be checked without its campaign file. */
  readonly providerInstanceId: string;
  readonly model: string;
  readonly listing: Listing | null;
  readonly pair: number;
  /** 0 when this arm went first in its pair. */
  readonly slot: number;
  readonly threadId: string | null;
  readonly ok: boolean;
  /** Why the run failed. A failed run stays in the failure rate. */
  readonly failures: ReadonlyArray<string>;
  /** Why the run does not measure its arm. Listed in the report, left out of every ratio. */
  readonly contamination: ReadonlyArray<string>;
  readonly metrics: RunMetrics | null;
  readonly wallMs: number | null;
  readonly at: string;
  /** Later runs of the eval thread counted into this run; absent in rows before task set 3. */
  readonly followupRuns?: number;
  /** What the runner stopped once it had the answer, so no unmeasured paid run followed. */
  readonly cleanup?: Cleanup | null;
  /** tools/list as the runner's client saw it just before launch. */
  readonly observedListing?: ObservedListing | null;
}

export interface Cleanup {
  /** Delegated children still unfinished when the runner stopped the thread. */
  readonly unfinishedTasks: ReadonlyArray<string>;
  readonly stopped: boolean;
  readonly error: string | null;
}

export interface ObservedListing {
  readonly tools: number;
  /** Names only when few enough to read: the core listing. */
  readonly names: ReadonlyArray<string> | null;
}

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface ArmSummary {
  readonly arm: string;
  readonly runs: number;
  readonly contaminated: number;
  readonly clean: number;
  readonly failed: number;
  readonly failureRate: number | null;
  readonly wentFirst: number;
  readonly turnsMin: number | null;
  readonly turnsMax: number | null;
  readonly toolCalls: number | null;
  readonly failedToolCalls: number | null;
  readonly resultBytes: number | null;
  readonly wallMs: number | null;
}

export interface TaskSummary {
  readonly task: string;
  readonly claim: Claim;
  readonly baseline: ArmSummary;
  readonly candidate: ArmSummary | null;
  readonly verdict: "pass" | "fail" | "not_run" | "as_expected" | "suspect" | "baseline_only";
  readonly reasons: ReadonlyArray<string>;
}

const summarizeArm = (rows: ReadonlyArray<RunRow>, arm: string): ArmSummary => {
  const own = rows.filter((row) => row.arm === arm);
  const clean = own.filter((row) => row.contamination.length === 0);
  const succeeded = clean.filter((row) => row.ok && row.metrics !== null);
  const ok = succeeded.flatMap((row) => (row.metrics === null ? [] : [row.metrics]));
  const failed = clean.length - ok.length;
  return {
    arm,
    runs: own.length,
    contaminated: own.length - clean.length,
    clean: clean.length,
    failed,
    failureRate: clean.length === 0 ? null : failed / clean.length,
    wentFirst: own.filter((row) => row.slot === 0).length,
    // Medians come from successful runs: a run that gave up early would look cheap.
    turnsMin: median(ok.map((metrics) => metrics.modelTurns.min)),
    turnsMax: median(ok.map((metrics) => metrics.modelTurns.max)),
    toolCalls: median(ok.map((metrics) => metrics.toolCalls)),
    failedToolCalls: median(ok.map((metrics) => metrics.failedToolCalls)),
    resultBytes: median(ok.map((metrics) => metrics.resultBytes)),
    wallMs: median(succeeded.flatMap((row) => (row.wallMs === null ? [] : [row.wallMs]))),
  };
};

// Each run's true turn count lies somewhere in its range, so a reduction only holds if the
// candidate's most turns are below the baseline's fewest.
const fewerTurns = (baseline: ArmSummary, candidate: ArmSummary) =>
  baseline.turnsMin !== null &&
  candidate.turnsMax !== null &&
  candidate.turnsMax <= baseline.turnsMin * REQUIRED_TURN_RATIO;

// Both arms are counted the same way, so each end of the candidate's range is compared with the
// same end of the baseline's.
const turnsWithin = (baseline: ArmSummary, candidate: ArmSummary, allowance: number) =>
  baseline.turnsMin !== null &&
  baseline.turnsMax !== null &&
  candidate.turnsMin !== null &&
  candidate.turnsMax !== null &&
  candidate.turnsMin <= baseline.turnsMin + allowance &&
  candidate.turnsMax <= baseline.turnsMax + allowance;

const succeeded = (summary: ArmSummary) => summary.clean - summary.failed;

/**
 * The context-diet targets: a single-call control costs at most one more model turn, and a
 * multi-step task no more median turns, with no more failed runs in either.
 */
const listingVerdict = (
  task: Task,
  baseline: ArmSummary,
  candidate: ArmSummary,
): Pick<TaskSummary, "verdict" | "reasons"> => {
  const reasons: Array<string> = [];
  if (succeeded(baseline) < MIN_CLEAN_RUNS || succeeded(candidate) < MIN_CLEAN_RUNS)
    reasons.push("fewer than " + MIN_CLEAN_RUNS + " successful clean runs in an arm");
  const allowance = task.claim === "no_gain" ? CONTROL_TURN_ALLOWANCE : 0;
  if (!turnsWithin(baseline, candidate, allowance))
    reasons.push(
      allowance === 0
        ? "the candidate's median turns rose"
        : "the candidate's median turns rose by more than " + allowance,
    );
  if ((candidate.failureRate ?? 1) > (baseline.failureRate ?? 0))
    reasons.push("the candidate failed more often");
  if (reasons.length > 0) return { verdict: "fail", reasons };
  return { verdict: task.claim === "no_gain" ? "as_expected" : "pass", reasons };
};

export const summarizeTask = (
  task: Task,
  rows: ReadonlyArray<RunRow>,
  campaign: Pick<Campaign, "baselineArm" | "candidateArm"> & { readonly gate?: GateKind },
): TaskSummary => {
  const own = rows.filter((row) => row.task === task.id);
  const baseline = summarizeArm(own, campaign.baselineArm);
  if (campaign.candidateArm === null)
    return {
      task: task.id,
      claim: task.claim,
      baseline,
      candidate: null,
      verdict: baseline.clean === 0 ? "not_run" : "baseline_only",
      reasons: baseline.clean === 0 ? ["the baseline has no clean runs"] : [],
    };
  const candidate = summarizeArm(own, campaign.candidateArm);
  const base = { task: task.id, claim: task.claim, baseline, candidate };
  if (baseline.clean === 0 || candidate.clean === 0)
    return { ...base, verdict: "not_run", reasons: ["an arm has no clean runs"] };
  if (campaign.gate === "listing") return { ...base, ...listingVerdict(task, baseline, candidate) };
  if (task.claim === "no_gain")
    return fewerTurns(baseline, candidate)
      ? {
          ...base,
          verdict: "suspect",
          reasons: ["the control shows a gain; check what is counted"],
        }
      : { ...base, verdict: "as_expected", reasons: [] };
  const reasons: Array<string> = [];
  if (succeeded(baseline) < MIN_CLEAN_RUNS || succeeded(candidate) < MIN_CLEAN_RUNS)
    reasons.push("fewer than " + MIN_CLEAN_RUNS + " successful clean runs in an arm");
  if (!fewerTurns(baseline, candidate))
    reasons.push("the candidate's most turns are not a third below the baseline's fewest");
  if ((candidate.failureRate ?? 1) > (baseline.failureRate ?? 0))
    reasons.push("the candidate failed more often");
  return { ...base, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
};

/**
 * D8 passes only when every reduces task, manual ones included, ran and passed, and every
 * control ran and showed no gain; a control that moved means the count itself is suspect.
 */
export const gate = (summaries: ReadonlyArray<TaskSummary>) => {
  const notPassed = summaries.filter((summary) =>
    summary.claim === "reduces" ? summary.verdict !== "pass" : summary.verdict !== "as_expected",
  );
  return {
    pass: summaries.some((summary) => summary.claim === "reduces") && notPassed.length === 0,
    notPassed: notPassed.map((summary) => summary.task + ": " + summary.verdict),
  };
};
