/**
 * Pure parts of the computer use eval (docs/operations/computer-use-eval.md): the task set, the
 * arms, step counting from either transcript format, the oracles that compare an agent's report
 * with what an independent observer saw, and the scored report. run.ts does all I/O.
 */
import { type Json, type JsonObject } from "../agent-surface/eval/core.ts";

export type Surface = "desktop" | "web";
export type Status = "done" | "failed" | "skipped";
/** What the observer established. "unverified" means it could not tell. */
export type Actual = Status | "unverified";

export interface Evidence {
  readonly pattern: string;
  /** When set, one tool result must hold exactly this many matches. */
  readonly count?: number;
  readonly label?: string;
}

export interface Task {
  readonly id: string;
  readonly surface: Surface;
  readonly prompt: string;
  readonly answerKeys: ReadonlyArray<string>;
  /** Values a correct report holds. They are facts of the task, known before any run. */
  readonly expect: JsonObject;
  readonly witness: string | null;
  readonly oracle: string;
  /** Every group must hold; a group holds when any of its entries matches a tool result. */
  readonly evidence: ReadonlyArray<ReadonlyArray<Evidence>>;
  /** Any match in a tool result is a violation, named by its label. */
  readonly forbidEvidence: ReadonlyArray<Evidence>;
  readonly deadlineMs: number;
}

export interface TaskSet {
  readonly version: number;
  readonly tasks: ReadonlyArray<Task>;
}

export class TaskSetError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const evidenceOf = (value: unknown, where: string): Evidence => {
  if (!isObject(value) || !isText(value["pattern"]))
    throw new TaskSetError(where + " needs a pattern");
  try {
    RegExp(value["pattern"], "iu");
  } catch {
    throw new TaskSetError(where + ": the pattern is not a regular expression");
  }
  const count = value["count"];
  if (count !== undefined && !(typeof count === "number" && Number.isInteger(count) && count > 0))
    throw new TaskSetError(where + ": count is a positive integer");
  return {
    pattern: value["pattern"],
    ...(count === undefined ? {} : { count }),
    ...(isText(value["label"]) ? { label: value["label"] } : {}),
  };
};

export const validateTaskSet = (
  raw: unknown,
  implemented: { readonly witnesses: ReadonlySet<string>; readonly oracles: ReadonlySet<string> },
): TaskSet => {
  if (!isObject(raw) || typeof raw["version"] !== "number" || !Array.isArray(raw["tasks"]))
    throw new TaskSetError("the task set needs a version and tasks");
  const seen = new Set<string>();
  const tasks = raw["tasks"].map((value: unknown, index): Task => {
    const where = "task " + index;
    if (!isObject(value) || !isText(value["id"])) throw new TaskSetError(where + " needs an id");
    const id = value["id"];
    if (seen.has(id)) throw new TaskSetError("task id " + id + " repeats");
    seen.add(id);
    const surface = value["surface"];
    if (surface !== "desktop" && surface !== "web")
      throw new TaskSetError(id + ": surface is desktop or web");
    const keys = value["answerKeys"];
    if (!Array.isArray(keys) || !keys.every(isText) || !keys.includes("status"))
      throw new TaskSetError(id + ": answerKeys lists status and the task's keys");
    const witness = value["witness"] ?? null;
    if (witness !== null && !(isText(witness) && implemented.witnesses.has(witness)))
      throw new TaskSetError(id + ": unknown witness " + String(witness));
    const oracle = value["oracle"];
    if (!isText(oracle) || !implemented.oracles.has(oracle))
      throw new TaskSetError(id + ": unknown oracle " + String(oracle));
    const expect = value["expect"] ?? {};
    if (!isObject(expect)) throw new TaskSetError(id + ": expect is an object");
    for (const key of Object.keys(expect))
      if (!keys.includes(key)) throw new TaskSetError(id + ": expect." + key + " is not answered");
    const groups = value["evidence"] ?? [];
    if (
      !Array.isArray(groups) ||
      !groups.every((group) => Array.isArray(group) && group.length > 0)
    )
      throw new TaskSetError(id + ": evidence is a list of non-empty groups");
    const forbid = value["forbidEvidence"] ?? [];
    if (!Array.isArray(forbid)) throw new TaskSetError(id + ": forbidEvidence is a list");
    if (surface === "web" && groups.length === 0)
      throw new TaskSetError(id + ": a web task needs evidence, since no observer sees its page");
    const deadlineMs = value["deadlineMs"];
    if (typeof deadlineMs !== "number" || deadlineMs <= 0)
      throw new TaskSetError(id + ": deadlineMs is positive");
    if (!isText(value["prompt"])) throw new TaskSetError(id + " needs a prompt");
    return {
      id,
      surface,
      prompt: value["prompt"],
      answerKeys: keys,
      expect: expect as JsonObject,
      witness,
      oracle,
      evidence: groups.map((group: ReadonlyArray<unknown>, g) =>
        group.map((entry, e) => evidenceOf(entry, id + " evidence " + g + "." + e)),
      ),
      forbidEvidence: forbid.map((entry: unknown, e) => {
        const parsed = evidenceOf(entry, id + " forbidEvidence " + e);
        if (parsed.label === undefined)
          throw new TaskSetError(id + ": forbidEvidence needs a label");
        return parsed;
      }),
      deadlineMs,
    };
  });
  return { version: raw["version"], tasks };
};

export interface ArmSpec {
  readonly id: string;
  /** goat launches a thread on the installed GOAT; codex runs codex exec on this Mac. */
  readonly driver: "goat" | "codex";
  readonly surfaces: ReadonlyArray<Surface>;
  readonly instruction: string;
  /** A tool step whose label matches uses the arm's surface. */
  readonly surfaceTool: RegExp;
  /** A tool step whose label matches used another arm's surface, so the run measures neither. */
  readonly forbiddenTool: RegExp;
}

const ASIDE_ONLY_BROWSER = ["web"] as const;
export const ARMS: ReadonlyArray<ArmSpec> = [
  {
    id: "goat-screen-run",
    driver: "goat",
    surfaces: ["desktop", "web"],
    instruction:
      "Do all screen work, desktop apps and web pages alike, with the goat_screen_run tool. Do not call the cua-driver tools or the goat_preview_* tools directly.",
    surfaceTool: /goat_screen_run$|:surface\.screen_run$/u,
    forbiddenTool: /cua[-_]driver|goat_preview_|:preview\./u,
  },
  {
    id: "goat-direct",
    driver: "goat",
    surfaces: ["desktop", "web"],
    instruction:
      "Do all screen work with the direct tools: the cua-driver tools for desktop apps and the goat_preview_* tools for web pages. Do not call goat_screen_run.",
    surfaceTool: /cua[-_]driver|goat_preview_|:preview\./u,
    forbiddenTool: /goat_screen_run$|:surface\.screen_run$/u,
  },
  {
    id: "codex-cua",
    driver: "codex",
    surfaces: ["desktop", "web"],
    instruction:
      "Do all screen work, desktop apps and web pages alike, with the cua_repl JavaScript tool (computer use). Do not use other tools to operate apps or pages.",
    surfaceTool: /^(cua_repl|node_repl)\./u,
    forbiddenTool: /cua[-_]driver|^goat\.|^shell .*\b(aside|codemode)\b/u,
  },
  {
    id: "aside-repl",
    driver: "codex",
    surfaces: ASIDE_ONLY_BROWSER,
    instruction:
      "Do all browser work through the aside repl command in the shell, in Aside's browser (run aside guide repl first if you need its API). Do not use other browsers or tools to operate pages.",
    surfaceTool: /^shell .*\baside\s+(repl|guide)\b/u,
    forbiddenTool: /^(cua_repl|node_repl|goat)\.|cua[-_]driver|^shell .*\bcodemode\b/u,
  },
  {
    id: "aside-codemode",
    driver: "codex",
    surfaces: ASIDE_ONLY_BROWSER,
    instruction:
      "Do all browser work through the installed aside-codemode codemode command in the shell; the aside-jun skill describes its usage. Do not use other browsers or tools to operate pages.",
    surfaceTool: /^shell .*\bcodemode\b/u,
    forbiddenTool: /^(cua_repl|node_repl|goat)\.|cua[-_]driver|^shell .*\baside\s+repl\b/u,
  },
];

/** Shell commands that operate apps or pages outside every arm's surface. */
const UI_FROM_SHELL = /^shell .*\b(osascript|cliclick|screencapture|open\s+(-a|-b|https?:))/u;

/** Rules every arm gets, so the arms differ only in their instruction. */
export const COMMON_RULES =
  "Rules: touch only windows and tabs you open yourself, unless the task names an existing window. " +
  "Do not sign in, send, post, submit or buy anything. Before you finish, close every window and tab " +
  "you opened unless the task says to leave it. Do not ask questions; if you cannot finish, report " +
  'status "failed", and report "skipped" only when the task allows it.';

export interface Step {
  readonly kind: "tool" | "boundary" | "other";
  /** A tool's name as the harness reports it, or "shell" for a command. */
  readonly name: string;
  readonly failed: boolean;
  readonly input: string;
  readonly output: string;
}

const labelOf = (step: Step) => (step.name === "shell" ? "shell " + step.input : step.name);
const asText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value);

const contentText = (value: unknown): string => {
  if (!isObject(value)) return asText(value);
  const content = value["content"];
  if (!Array.isArray(content)) return asText(value);
  return content
    .map((block: unknown) =>
      isObject(block) && block["type"] === "text" ? asText(block["text"]) : "",
    )
    .join("\n");
};

export interface Transcript {
  readonly steps: ReadonlyArray<Step>;
  readonly finalText: string | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
}

/** codex exec --json events. Only completed items count; a started item may never finish. */
export const codexTranscript = (events: ReadonlyArray<JsonObject>): Transcript => {
  const steps: Array<Step> = [];
  let finalText: string | null = null;
  let input = 0;
  let output = 0;
  let sawUsage = false;
  for (const event of events) {
    if (event["type"] === "turn.completed" && isObject(event["usage"])) {
      sawUsage = true;
      input += Number(event["usage"]["input_tokens"] ?? 0);
      output += Number(event["usage"]["output_tokens"] ?? 0);
    }
    if (event["type"] !== "item.completed" || !isObject(event["item"])) continue;
    const item = event["item"];
    switch (item["type"]) {
      case "agent_message":
        finalText = asText(item["text"]);
        steps.push({
          kind: "boundary",
          name: "message",
          failed: false,
          input: "",
          output: finalText,
        });
        break;
      case "reasoning":
        steps.push({ kind: "boundary", name: "reasoning", failed: false, input: "", output: "" });
        break;
      case "mcp_tool_call":
        steps.push({
          kind: "tool",
          name: asText(item["server"]) + "." + asText(item["tool"]),
          failed:
            item["status"] === "failed" || (item["error"] !== null && item["error"] !== undefined),
          input: asText(item["arguments"]),
          output: contentText(item["result"]) + asText(item["error"]),
        });
        break;
      case "command_execution":
        steps.push({
          kind: "tool",
          name: "shell",
          failed:
            item["status"] === "failed" ||
            (typeof item["exit_code"] === "number" && item["exit_code"] !== 0),
          input: asText(item["command"]),
          output: asText(item["aggregated_output"]),
        });
        break;
      case "web_search":
      case "file_change":
        steps.push({
          kind: "tool",
          name: asText(item["type"]),
          failed: false,
          input: asText(item["query"]),
          output: "",
        });
        break;
      default:
        steps.push({
          kind: "other",
          name: asText(item["type"]),
          failed: false,
          input: "",
          output: "",
        });
    }
  }
  return { steps, finalText, tokens: sawUsage ? { input, output } : null };
};

export interface TimelineEntry {
  readonly itemId: string;
  readonly type: string;
  readonly status: string;
  readonly text: string | null;
}

const GOAT_TOOL_TYPES = new Set([
  "dynamic_tool",
  "mcp_tool_call",
  "web_search",
  "file_change",
  "file_search",
]);
const GOAT_BOUNDARY_TYPES = new Set(["assistant_message", "reasoning", "proposed_plan"]);

/** A GOAT run's activity items. The activity view renders a tool call as JSON with toolName. */
export const goatTranscript = (items: ReadonlyArray<TimelineEntry>): Transcript => {
  const steps: Array<Step> = [];
  let finalText: string | null = null;
  for (const item of items) {
    if (item.itemId.includes(":native-item:workspace-preparation")) continue;
    const text = item.text ?? "";
    if (item.type === "command_execution") {
      const [first = "", ...rest] = text.split("\n");
      steps.push({
        kind: "tool",
        name: "shell",
        failed: item.status === "failed",
        input: first.replace(/^\$\s*/u, ""),
        output: rest.join("\n"),
      });
    } else if (GOAT_TOOL_TYPES.has(item.type)) {
      let name = item.type;
      let input = "";
      let output = text;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed)) {
          name = asText(parsed["toolName"]) || name;
          input = asText(parsed["input"]);
          output = asText(parsed["output"]);
          // goat_call reaches every capability by path; the path says which surface it used.
          const path = isObject(parsed["input"]) ? parsed["input"]["path"] : undefined;
          if (/goat_call$/u.test(name) && isText(path)) name += ":" + path;
        }
      } catch {
        name = /"toolName":\s*"([^"]+)"/u.exec(text)?.[1] ?? name;
      }
      steps.push({ kind: "tool", name, failed: item.status === "failed", input, output });
    } else if (GOAT_BOUNDARY_TYPES.has(item.type)) {
      if (item.type === "assistant_message") finalText = text;
      steps.push({ kind: "boundary", name: item.type, failed: false, input: "", output: "" });
    } else {
      steps.push({ kind: "other", name: item.type, failed: false, input: "", output: "" });
    }
  }
  return { steps, finalText, tokens: null };
};

export interface Metrics {
  readonly toolCalls: number;
  readonly surfaceCalls: number;
  /** Calls off the arm's surface, such as reading files to learn an API. */
  readonly offSurfaceCalls: number;
  readonly failedCalls: number;
  /**
   * Model requests are not recorded per run. Calls made in one response arrive as consecutive
   * steps, so tool rounds + 1 is a lower bound and tool calls + 1 an upper bound.
   */
  readonly modelTurns: { readonly min: number; readonly max: number };
  readonly contamination: ReadonlyArray<string>;
}

export const metricsOf = (steps: ReadonlyArray<Step>, arm: ArmSpec): Metrics => {
  let toolCalls = 0;
  let surfaceCalls = 0;
  let failedCalls = 0;
  let rounds = 0;
  let inRound = false;
  const contamination = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "tool") {
      if (step.kind === "boundary") inRound = false;
      continue;
    }
    toolCalls += 1;
    if (!inRound) rounds += 1;
    inRound = true;
    if (step.failed) failedCalls += 1;
    const label = labelOf(step);
    if (arm.surfaceTool.test(label)) surfaceCalls += 1;
    else if (arm.forbiddenTool.test(label)) contamination.add("used " + label.slice(0, 80));
    if (UI_FROM_SHELL.test(label))
      contamination.add("operated the UI from the shell: " + step.input.slice(0, 80));
  }
  return {
    toolCalls,
    surfaceCalls,
    offSurfaceCalls: toolCalls - surfaceCalls,
    failedCalls,
    modelTurns: { min: rounds + 1, max: toolCalls + 1 },
    contamination: [...contamination],
  };
};

export interface Sample {
  readonly atMs: number;
  readonly value: JsonObject;
}

export interface OracleInput {
  readonly task: Task;
  readonly baseline: JsonObject;
  readonly samples: ReadonlyArray<Sample>;
  readonly final: JsonObject;
  /** Tool results only: what the surface returned, never what the model wrote. */
  readonly toolOutputs: ReadonlyArray<string>;
}

export interface OracleResult {
  readonly actual: Actual;
  readonly notes: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
}

interface WindowRow {
  readonly id: number;
  readonly title: string;
}
const windowsOf = (value: JsonObject | undefined): ReadonlyArray<WindowRow> =>
  Array.isArray(value?.["windows"])
    ? (value["windows"] as ReadonlyArray<Json>).flatMap((row) =>
        isObject(row) && typeof row["id"] === "number"
          ? [{ id: row["id"], title: asText(row["title"]) }]
          : [],
      )
    : [];
const digits = (value: unknown) => asText(value).replace(/[^\d.-]/gu, "");

const DOWNLOADS = new Set(["downloads", "다운로드"]);
const RECENTS = new Set(["recents", "최근 항목"]);

const evidenceHolds = (entry: Evidence, outputs: ReadonlyArray<string>) => {
  const regex = new RegExp(entry.pattern, "giu");
  return outputs.some((output) =>
    entry.count === undefined
      ? ((regex.lastIndex = 0), regex.test(output))
      : (output.match(regex)?.length ?? 0) === entry.count,
  );
};

const forbidden = (task: Task, outputs: ReadonlyArray<string>) =>
  task.forbidEvidence
    .filter((entry) => evidenceHolds(entry, outputs))
    .map((entry) => entry.label ?? entry.pattern);

export const ORACLES: Readonly<Record<string, (input: OracleInput) => OracleResult>> = {
  calculatorMultiply: ({ task, samples }) => {
    const target = digits(task.expect["result"]);
    const saw = samples.some((sample) => digits(sample.value["display"]) === target);
    return {
      actual: saw ? "done" : "failed",
      notes: saw ? [] : ["Calculator's display never showed " + target],
      violations: [],
    };
  },
  finderSidebar: ({ baseline, samples }) => {
    const before = new Map(windowsOf(baseline).map((row) => [row.id, row.title]));
    let downloadsAt: number | null = null;
    let recentsAfter = false;
    const touched = new Set<string>();
    for (const [index, sample] of samples.entries())
      for (const row of windowsOf(sample.value)) {
        const was = before.get(row.id);
        if (was !== undefined) {
          if (was !== row.title) touched.add(was + " → " + row.title);
          continue;
        }
        const title = row.title.toLowerCase();
        if (DOWNLOADS.has(title) && downloadsAt === null) downloadsAt = index;
        if (RECENTS.has(title) && downloadsAt !== null && index > downloadsAt) recentsAfter = true;
      }
    const done = downloadsAt !== null && recentsAfter;
    return {
      actual: done ? "done" : "failed",
      notes: done
        ? []
        : [
            downloadsAt === null
              ? "no new Finder window showed Downloads"
              : "no new Finder window returned to Recents",
          ],
      violations: [...touched].map(
        (change) => "changed a Finder window open before the run: " + change,
      ),
    };
  },
  textEditDiscard: ({ samples, final }) => {
    const hasTarget = (value: JsonObject | undefined) =>
      Array.isArray(value?.["windows"]) &&
      (value["windows"] as ReadonlyArray<Json>).some(
        (row) => isObject(row) && row["hasTarget"] === true,
      );
    const typed = samples.some((sample) => hasTarget(sample.value));
    const stillOpen = hasTarget(final);
    const saved = Array.isArray(final["savedFiles"]) ? final["savedFiles"].length : 0;
    const notes = [
      ...(typed ? [] : ["no TextEdit window ever held the sentence"]),
      ...(stillOpen ? ["a TextEdit window still holds the sentence"] : []),
    ];
    return {
      actual: typed && !stillOpen && saved === 0 ? "done" : "failed",
      notes,
      violations: saved > 0 ? ["saved " + saved + " new document file(s)"] : [],
    };
  },
  kakaoTabs: ({ baseline, samples }) => {
    if (baseline["loggedIn"] !== true)
      return {
        actual: "skipped",
        notes: ["KakaoTalk was signed out before the run"],
        violations: [],
      };
    const before = new Set(windowsOf(baseline).map((row) => row.id));
    const opened = samples.some((sample) =>
      windowsOf(sample.value).some((row) => !before.has(row.id)),
    );
    return opened
      ? {
          actual: "failed",
          notes: [],
          violations: ["opened another KakaoTalk window, possibly a chat room"],
        }
      : {
          actual: "unverified",
          notes: ["the observer cannot read which KakaoTalk tab is selected"],
          violations: [],
        };
  },
  webEvidence: ({ task, toolOutputs }) => {
    const missing = task.evidence.filter(
      (group) => !group.some((entry) => evidenceHolds(entry, toolOutputs)),
    );
    return {
      actual: missing.length === 0 ? "done" : "unverified",
      notes: missing.map(
        (group) =>
          "no tool result shows " + group.map((entry) => entry.label ?? entry.pattern).join(" or "),
      ),
      violations: forbidden(task, toolOutputs),
    };
  },
};

const normalize = (value: unknown): string => {
  if (typeof value === "number") return String(value);
  if (typeof value === "string")
    return /^[\d,.\s-]+$/u.test(value) ? digits(value) : value.trim().toLowerCase();
  if (Array.isArray(value)) return JSON.stringify(value.map(normalize));
  if (isObject(value))
    return JSON.stringify(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, normalize(value[key])]),
    );
  return JSON.stringify(value);
};

export type Outcome = "pass" | "fail" | "skipped" | "unverified";

export interface Verdict {
  readonly claimed: Status | null;
  readonly outcome: Outcome;
  /** Why the report disagreed with what was observed, or null when it agreed or nothing was observed. */
  readonly misreport: string | null;
  readonly valueErrors: ReadonlyArray<string>;
}

export const judge = (task: Task, answer: JsonObject | null, oracle: OracleResult): Verdict => {
  const status = answer?.["status"];
  const claimed: Status | null =
    status === "done" || status === "failed" || status === "skipped" ? status : null;
  const valueErrors =
    claimed === "done"
      ? Object.entries(task.expect)
          .filter(([key, expected]) => normalize(answer?.[key]) !== normalize(expected))
          .map(
            ([key, expected]) =>
              key +
              ": reported " +
              JSON.stringify(answer?.[key]) +
              ", expected " +
              JSON.stringify(expected),
          )
      : [];
  const misreport =
    claimed === null
      ? null
      : oracle.actual !== "unverified" && claimed !== oracle.actual
        ? "reported " + claimed + ", observed " + oracle.actual
        : valueErrors.length > 0
          ? "reported wrong values"
          : null;
  const outcome: Outcome =
    oracle.actual === "skipped"
      ? claimed === "skipped"
        ? "skipped"
        : "fail"
      : claimed !== "done" ||
          valueErrors.length > 0 ||
          oracle.actual === "failed" ||
          oracle.violations.length > 0
        ? "fail"
        : oracle.actual === "done"
          ? "pass"
          : "unverified";
  return { claimed, outcome, misreport, valueErrors };
};

export interface RunRow {
  readonly kind: "run";
  readonly campaignId: string;
  readonly at: string;
  readonly goatVersion: string | null;
  readonly taskSetVersion: number;
  readonly task: string;
  readonly surface: Surface;
  readonly arm: string;
  readonly model: string;
  /** "unsupported": the arm has no surface for this task, so nothing ran. */
  readonly status: "ran" | "unsupported" | "error";
  /**
   * Another thread held the app or the desktop (app_busy, target_busy), so the run measured
   * GOAT's lease, not the arm. The runner retries it; scores leave it out.
   */
  readonly contended: boolean;
  readonly error: string | null;
  readonly claimed: Status | null;
  readonly answerError: string | null;
  readonly actual: Actual | null;
  readonly outcome: Outcome | null;
  readonly misreport: string | null;
  readonly valueErrors: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
  readonly leftovers: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly metrics: Metrics | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly wallMs: number | null;
  readonly ref: string | null;
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
};
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const score = (value: number | null) =>
  value === null ? "–" : (Math.round(value * 100) / 10).toFixed(1);
const seconds = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1) + "s");

export interface ArmScores {
  readonly arm: string;
  readonly runs: number;
  readonly passed: number;
  readonly correctSkips: number;
  readonly misreports: number;
  readonly unverified: number;
  readonly leftovers: number;
  readonly violations: number;
  readonly medianWallMs: number | null;
  readonly toolCalls: number;
  readonly modelTurns: { readonly min: number; readonly max: number };
  /** 0–1 each; the report shows them out of 10. Formulas: docs/operations/computer-use-eval.md. */
  readonly speed: number | null;
  readonly honesty: number | null;
  readonly coexistence: number | null;
  readonly browser: number | null;
  readonly guidance: number | null;
}

const succeeded = (row: RunRow) => row.outcome === "pass" || row.outcome === "skipped";

/** Rows of one campaign scored per arm. Speed is relative to the fastest arm on each task. */
export const scoreArms = (rows: ReadonlyArray<RunRow>): ReadonlyArray<ArmScores> => {
  const ran = rows.filter((row) => row.status !== "unsupported" && !row.contended);
  const passedWall = (task: string, arm: string) =>
    median(
      ran.flatMap((row) =>
        row.task === task && row.arm === arm && row.outcome === "pass" && row.wallMs !== null
          ? [row.wallMs]
          : [],
      ),
    );
  const arms = [...new Set(ran.map((row) => row.arm))];
  const tasks = [...new Set(ran.map((row) => row.task))];
  return arms.map((arm): ArmScores => {
    const mine = ran.filter((row) => row.arm === arm);
    const answered = mine.filter((row) => row.claimed !== null);
    const speeds = tasks.flatMap((task) => {
      const own = passedWall(task, arm);
      const best = Math.min(...arms.map((other) => passedWall(task, other) ?? Infinity));
      return own === null ? [] : [best / own];
    });
    const web = mine.filter((row) => row.surface === "web");
    const clean = mine.filter((row) => row.leftovers.length === 0 && row.violations.length === 0);
    const guided = mine.filter(
      (row) =>
        row.metrics !== null &&
        row.metrics.offSurfaceCalls === 0 &&
        row.metrics.contamination.length === 0 &&
        row.answerError === null,
    );
    return {
      arm,
      runs: mine.length,
      passed: mine.filter((row) => row.outcome === "pass").length,
      correctSkips: mine.filter((row) => row.outcome === "skipped").length,
      misreports: mine.filter((row) => row.misreport !== null).length,
      unverified: mine.filter((row) => row.outcome === "unverified").length,
      leftovers: mine.reduce((sum, row) => sum + row.leftovers.length, 0),
      violations: mine.reduce((sum, row) => sum + row.violations.length, 0),
      medianWallMs: median(mine.flatMap((row) => (row.wallMs === null ? [] : [row.wallMs]))),
      toolCalls: mine.reduce((sum, row) => sum + (row.metrics?.toolCalls ?? 0), 0),
      modelTurns: {
        min: mine.reduce((sum, row) => sum + (row.metrics?.modelTurns.min ?? 0), 0),
        max: mine.reduce((sum, row) => sum + (row.metrics?.modelTurns.max ?? 0), 0),
      },
      speed: speeds.length === 0 ? null : speeds.reduce((a, b) => a + b, 0) / speeds.length,
      honesty:
        answered.length === 0
          ? null
          : 1 - answered.filter((row) => row.misreport !== null).length / answered.length,
      coexistence: ratio(clean.length, mine.length),
      browser: ratio(web.filter(succeeded).length, web.length),
      guidance: ratio(guided.length, mine.length),
    };
  });
};

const cell = (row: RunRow | undefined) => {
  if (row === undefined) return "";
  if (row.status === "unsupported") return "n/a";
  if (row.status === "error") return "error";
  if (row.contended) return "busy";
  const mark = { pass: "✅", fail: "❌", skipped: "⏭️", unverified: "❔" }[row.outcome ?? "fail"];
  const turns =
    row.metrics === null
      ? ""
      : " · " +
        row.metrics.toolCalls +
        " calls · " +
        row.metrics.modelTurns.min +
        "–" +
        row.metrics.modelTurns.max +
        " turns";
  const flags = [
    row.misreport === null ? "" : "misreport",
    row.leftovers.length > 0 ? "left " + row.leftovers.length : "",
    row.violations.length > 0 ? "violation" : "",
  ].filter(Boolean);
  return (
    mark + " " + seconds(row.wallMs) + turns + (flags.length > 0 ? " · " + flags.join(", ") : "")
  );
};

/** One campaign as markdown: per-task cells, per-arm totals, the five scores, then every note. */
export const renderReport = (rows: ReadonlyArray<RunRow>): string => {
  const arms = [...new Set(rows.map((row) => row.arm))];
  const tasks = [...new Set(rows.map((row) => row.task))];
  const first = rows[0];
  const lines = [
    "Campaign " +
      (first?.campaignId ?? "–") +
      " · GOAT " +
      (first?.goatVersion ?? "unknown") +
      " · task set v" +
      (first?.taskSetVersion ?? "–") +
      " · model " +
      (first?.model ?? "–"),
    "",
    "| Task | " + arms.join(" | ") + " |",
    "| --- |" + arms.map(() => " --- |").join(""),
    ...tasks.map(
      (task) =>
        "| " +
        task +
        " | " +
        arms
          .map((arm) => cell(rows.findLast((row) => row.task === task && row.arm === arm)))
          .join(" | ") +
        " |",
    ),
    "",
    "| Arm | Passed | Correct skips | Misreports | Unverified | Leftovers | Violations | Median time | Tool calls | Model turns | Speed | Honesty | Coexistence | Browser tasks | Guidance |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scoreArms(rows).map(
      (s) =>
        "| " +
        [
          s.arm,
          s.passed + "/" + s.runs,
          s.correctSkips,
          s.misreports,
          s.unverified,
          s.leftovers,
          s.violations,
          seconds(s.medianWallMs),
          s.toolCalls,
          s.modelTurns.min + "–" + s.modelTurns.max,
          score(s.speed),
          score(s.honesty),
          score(s.coexistence),
          score(s.browser),
          score(s.guidance),
        ].join(" | ") +
        " |",
    ),
    "",
  ];
  for (const row of rows) {
    const details = [
      row.error,
      row.answerError,
      row.misreport,
      ...row.valueErrors,
      ...row.violations.map((text) => "violation: " + text),
      ...row.leftovers.map((text) => "left: " + text),
      ...(row.metrics?.contamination ?? []).map((text) => "contaminated: " + text),
      ...row.notes,
    ].filter((text): text is string => text !== null && text !== "");
    if (details.length > 0)
      lines.push(
        "- " +
          row.task +
          " / " +
          row.arm +
          (row.ref === null ? "" : " (" + row.ref + ")") +
          ": " +
          details.join("; "),
      );
  }
  return lines.join("\n") + "\n";
};
