/**
 * Pure parts of the computer use eval (docs/operations/computer-use-eval.md): the task set, the
 * arms, step counting from either transcript format, the oracles that compare an agent's report
 * with what an independent observer saw, and the scored report. run.ts does all I/O.
 */
import { type Json, type JsonObject, extractAnswer } from "../agent-surface/eval/core.ts";

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
  /** Every evidence group must hold in one tool result, so the values come from one read. */
  readonly sameResult: boolean;
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
    const sameResult = value["sameResult"] ?? false;
    if (typeof sameResult !== "boolean") throw new TaskSetError(id + ": sameResult is a boolean");
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
      sameResult,
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
    forbiddenTool: /cua[-_]driver|^goat\.|^shell .*\b(aside|codemode)\b/su,
  },
  {
    id: "aside-repl",
    driver: "codex",
    surfaces: ASIDE_ONLY_BROWSER,
    instruction:
      "Do all browser work through the aside repl command in the shell, in Aside's browser (run aside guide repl first if you need its API). Do not use other browsers or tools to operate pages.",
    surfaceTool: /^shell .*\baside\s+(repl|guide)\b/su,
    forbiddenTool: /^(cua_repl|node_repl|goat)\.|cua[-_]driver|^shell .*\bcodemode\b/su,
  },
  {
    id: "aside-codemode",
    driver: "codex",
    surfaces: ASIDE_ONLY_BROWSER,
    instruction:
      "Do all browser work through the installed aside-codemode codemode command in the shell; the aside-jun skill describes its usage. Do not use other browsers or tools to operate pages.",
    surfaceTool: /^shell .*\bcodemode\b/su,
    forbiddenTool: /^(cua_repl|node_repl|goat)\.|cua[-_]driver|^shell .*\baside\s+repl\b/su,
  },
];

/** Shell commands that operate apps or pages outside every arm's surface. */
const UI_FROM_SHELL = /^shell .*\b(osascript|cliclick|screencapture|open\s+(-a|-b|https?:))/su;

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
  /** Some tool call could not be read whole, so evidence of a failure may be missing. */
  readonly incomplete: boolean;
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
  return { steps, finalText, tokens: sawUsage ? { input, output } : null, incomplete: false };
};

export interface TimelineEntry {
  readonly itemId: string;
  readonly type: string;
  readonly status: string;
  readonly text: string | null;
  /** False when the runner stopped reading a long item before its end. */
  readonly complete?: boolean;
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
  let incomplete = false;
  for (const item of items) {
    if (item.itemId.includes(":native-item:workspace-preparation")) continue;
    if (item.complete === false) incomplete = true;
    const text = item.text ?? "";
    if (item.type === "command_execution") {
      // The activity text joins a command and its output with no boundary a multi-line command
      // keeps, so all of it is input and none of it can serve as evidence.
      steps.push({
        kind: "tool",
        name: "shell",
        failed: item.status === "failed",
        input: text.replace(/^\$\s*/u, ""),
        output: "",
      });
    } else if (GOAT_TOOL_TYPES.has(item.type)) {
      let name = item.type;
      let input = "";
      let output = "";
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
        // An envelope that does not parse mixes the call's input with its result, so none of it is
        // evidence; all of it is checked as input.
        name = /"toolName":\s*"([^"]+)"/u.exec(text)?.[1] ?? name;
        input = text;
        incomplete = true;
      }
      steps.push({ kind: "tool", name, failed: item.status === "failed", input, output });
    } else if (GOAT_BOUNDARY_TYPES.has(item.type)) {
      if (item.type === "assistant_message") finalText = text;
      steps.push({ kind: "boundary", name: item.type, failed: false, input: "", output: "" });
    } else {
      steps.push({ kind: "other", name: item.type, failed: false, input: "", output: "" });
    }
  }
  return { steps, finalText, tokens: null, incomplete };
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
    // Checked on its own: one shell call can reach this arm's surface and another's.
    if (
      arm.forbiddenTool.test(label) ||
      ARMS.some((other) => other.id !== arm.id && other.surfaceTool.test(label))
    )
      contamination.add("used " + label.slice(0, 80));
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

/**
 * Tool results in one shape whatever surface printed them: JSON string escapes undone, and the
 * accessibility tree's "checkbox (settable, integer) 1" written as the snapshot's "checkbox [checked]".
 */
export const canonicalEvidence = (output: string) =>
  output
    .replace(/\\n/gu, "\n")
    .replace(/\\"/gu, '"')
    .replace(/checkbox \(settable, integer\) 1\b/gu, "checkbox [checked]")
    .replace(/checkbox \(settable, integer\) 0\b/gu, "checkbox");

const evidenceIn = (entry: Evidence, raw: string) => {
  const output = canonicalEvidence(raw);
  const regex = new RegExp(entry.pattern, "giu");
  return entry.count === undefined
    ? regex.test(output)
    : (output.match(regex)?.length ?? 0) === entry.count;
};
const groupHolds = (group: ReadonlyArray<Evidence>, output: string) =>
  group.some((entry) => evidenceIn(entry, output));

const forbidden = (task: Task, outputs: ReadonlyArray<string>) =>
  task.forbidEvidence
    .filter((entry) => outputs.some((output) => evidenceIn(entry, output)))
    .map((entry) => entry.label ?? entry.pattern);

interface WindowTrack {
  /** Titles of each window that was not open before the run, in the order they were seen. */
  readonly created: ReadonlyMap<number, ReadonlyArray<JsonObject>>;
  /** New windows first seen in the final read, after the last sample. */
  readonly appearedAtEnd: ReadonlySet<number>;
  readonly violations: ReadonlyArray<string>;
}

/** Follows windows by id: new ones by their rows, earlier ones for any change or closing. */
const trackWindows = (
  app: string,
  baseline: JsonObject,
  samples: ReadonlyArray<Sample>,
  final: JsonObject,
): WindowTrack => {
  const before = new Map(
    (Array.isArray(baseline["windows"])
      ? (baseline["windows"] as ReadonlyArray<Json>)
      : []
    ).flatMap((row) =>
      isObject(row) && typeof row["id"] === "number"
        ? [[row["id"], { title: asText(row["title"]), print: row["print"] }] as const]
        : [],
    ),
  );
  const created = new Map<number, Array<JsonObject>>();
  const appearedAtEnd = new Set<number>();
  const violations = new Set<string>();
  // The final read is checked like a sample, so a change after the last sample still counts.
  for (const value of [...samples.map((sample) => sample.value), final]) {
    const rows = Array.isArray(value["windows"]) ? (value["windows"] as ReadonlyArray<Json>) : [];
    for (const row of rows) {
      if (!isObject(row) || typeof row["id"] !== "number") continue;
      const was = before.get(row["id"]);
      if (was !== undefined) {
        if (was.title !== asText(row["title"]))
          violations.add(
            "changed a " +
              app +
              " window open before the run: " +
              was.title +
              " → " +
              asText(row["title"]),
          );
        // A text fingerprint catches any edit, adding or removing; unknown on either side proves nothing.
        if (
          typeof was.print === "string" &&
          typeof row["print"] === "string" &&
          was.print !== row["print"]
        )
          violations.add("changed the text of a " + app + " window open before the run");
        continue;
      }
      if (value === final) {
        if (!created.has(row["id"])) appearedAtEnd.add(row["id"]);
        continue;
      }
      const seen = created.get(row["id"]) ?? [];
      if (JSON.stringify(seen.at(-1)) !== JSON.stringify(row)) seen.push(row as JsonObject);
      created.set(row["id"], seen);
    }
  }
  if (Array.isArray(final["windows"])) {
    const open = new Set(windowsOf(final).map((row) => row.id));
    for (const [id, was] of before)
      if (!open.has(id))
        violations.add("closed a " + app + " window open before the run: " + was.title);
  }
  return { created, appearedAtEnd, violations: [...violations] };
};

export const ORACLES: Readonly<Record<string, (input: OracleInput) => OracleResult>> = {
  calculatorMultiply: ({ task, samples }) => {
    const target = digits(task.expect["result"]);
    // After "=", Calculator shows the expression and the result in separate texts.
    const saw = samples.some((sample) =>
      [
        sample.value["display"],
        ...(Array.isArray(sample.value["texts"]) ? sample.value["texts"] : []),
      ].some((text) => digits(text) === target),
    );
    // Not seeing it proves nothing: a read and reset can fall between two samples.
    return {
      actual: saw ? "done" : "unverified",
      notes: saw ? [] : ["the observer never saw " + target + " on Calculator's display"],
      violations: [],
    };
  },

  finderSidebar: ({ baseline, samples, final }) => {
    const track = trackWindows("Finder", baseline, samples, final);
    const visited = [...track.created.values()].some((rows) => {
      const titles = rows.map((row) => asText(row["title"]).toLowerCase());
      const downloads = titles.findIndex((title) => DOWNLOADS.has(title));
      return downloads !== -1 && titles.slice(downloads + 1).some((title) => RECENTS.has(title));
    });
    return {
      actual: visited ? "done" : "unverified",
      notes: visited
        ? []
        : ["the observer saw no new Finder window show Downloads and then Recents"],
      violations: track.violations,
    };
  },
  textEditDiscard: ({ baseline, samples, final }) => {
    const track = trackWindows("TextEdit", baseline, samples, final);
    const holders = [...track.created]
      .filter(([, rows]) => rows.some((row) => row["hasTarget"] === true))
      .map(([id]) => id);
    // The window that held the sentence must be gone: a window that stays counts even when its
    // text can no longer be read.
    const earlier = new Set(windowsOf(baseline).map((row) => row.id));
    const open = new Set(windowsOf(final).map((row) => row.id));
    const holdingAtEnd = (
      Array.isArray(final["windows"]) ? (final["windows"] as ReadonlyArray<Json>) : []
    ).flatMap((row) =>
      isObject(row) && typeof row["id"] === "number" && row["hasTarget"] === true
        ? [row["id"]]
        : [],
    );
    const stillOpen =
      holders.some((id) => open.has(id)) || holdingAtEnd.some((id) => !earlier.has(id));
    const saved = Array.isArray(final["savedFiles"]) ? final["savedFiles"].length : 0;
    const violations = [
      ...track.violations,
      ...(saved > 0 ? ["saved " + saved + " new document file(s)"] : []),
    ];
    if (stillOpen)
      return {
        actual: "failed",
        notes: ["the TextEdit window that held the sentence is still open"],
        violations,
      };
    return {
      actual: holders.length > 0 ? "done" : "unverified",
      notes:
        holders.length > 0 ? [] : ["the observer never saw the sentence in a new TextEdit window"],
      violations,
    };
  },

  kakaoTabs: ({ baseline, samples, final }) => {
    const track = trackWindows("KakaoTalk", baseline, samples, final);
    const opened =
      track.created.size + track.appearedAtEnd.size > 0
        ? ["opened another KakaoTalk window, possibly a chat room"]
        : [];
    const violations = [...track.violations, ...opened];
    if (baseline["loggedIn"] !== true)
      return { actual: "skipped", notes: ["KakaoTalk was signed out before the run"], violations };
    return {
      actual: "unverified",
      notes: ["the observer cannot read which KakaoTalk tab is selected"],
      violations,
    };
  },

  webEvidence: ({ task, toolOutputs }) => {
    const missing = task.sameResult
      ? toolOutputs.some((output) => task.evidence.every((group) => groupHolds(group, output)))
        ? []
        : task.evidence
      : task.evidence.filter((group) => !toolOutputs.some((output) => groupHolds(group, output)));
    return {
      actual: missing.length === 0 ? "done" : "unverified",
      notes: missing.map(
        (group) =>
          "no tool result shows " +
          group.map((entry) => entry.label ?? entry.pattern).join(" or ") +
          (task.sameResult ? " in the same read as the rest" : ""),
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
  /** The observed status, with any violation counted as a failure. */
  readonly actual: Actual;
  readonly outcome: Outcome;
  /** Why the report disagreed with what was observed, or null when it agreed or nothing was observed. */
  readonly misreport: string | null;
  readonly valueErrors: ReadonlyArray<string>;
}

export const judge = (task: Task, answer: JsonObject | null, oracle: OracleResult): Verdict => {
  const status = answer?.["status"];
  const claimed: Status | null =
    status === "done" || status === "failed" || status === "skipped" ? status : null;
  // A violation means the task was not done as asked, whatever the evidence of its result.
  const actual: Actual = oracle.violations.length > 0 ? "failed" : oracle.actual;
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
      : actual !== "unverified" && claimed !== actual
        ? "reported " + claimed + ", observed " + actual
        : valueErrors.length > 0
          ? "reported wrong values"
          : null;
  const outcome: Outcome =
    actual === "skipped"
      ? claimed === "skipped"
        ? "skipped"
        : "fail"
      : claimed !== "done" || valueErrors.length > 0 || actual === "failed"
        ? "fail"
        : actual === "done"
          ? "pass"
          : "unverified";
  return { claimed, actual, outcome, misreport, valueErrors };
};

export interface Observations {
  readonly baseline: JsonObject;
  readonly samples: ReadonlyArray<Sample>;
  readonly final: JsonObject;
  /** Tool results, each cut to OUTPUT_LIMIT characters; live scoring reads the same cut text. */
  readonly toolOutputs: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<Step>;
  readonly finalText: string | null;
  /** The runner's own notes, such as a deadline; the oracle's are recomputed. */
  readonly notes: ReadonlyArray<string>;
  /** A stored copy lost text to the size limits, so evidence of a failure may be missing. */
  readonly truncated?: boolean;
  /** OBSERVATION_FORMAT of the runner that stored it; older copies did not track completeness. */
  readonly format?: number;
}

/** Raised when the stored observation shape changes in a way that --rescore must not trust. */
export const OBSERVATION_FORMAT = 2;

const OUTPUT_LIMIT = 200_000;
const INPUT_LIMIT = 20_000;

/** A run's raw observations in the size a row keeps. */
export const keepObservations = (observed: Observations): Observations => ({
  ...observed,
  format: OBSERVATION_FORMAT,
  toolOutputs: observed.toolOutputs.map((output) => output.slice(0, OUTPUT_LIMIT)),
  steps: observed.steps.map((step) => ({
    ...step,
    input: step.input.slice(0, INPUT_LIMIT),
    output: "",
  })),
  truncated:
    observed.truncated === true ||
    observed.toolOutputs.some((output) => output.length > OUTPUT_LIMIT) ||
    observed.steps.some((step) => step.input.length > INPUT_LIMIT),
});

/**
 * What observations score to under the current task set and rules. Live runs and --rescore both
 * call it, so a rule fixed later can be applied to stored runs without running them again.
 */
export const scoreRun = (task: Task, arm: ArmSpec, observed: Observations) => {
  const judgeBy = ORACLES[task.oracle];
  if (judgeBy === undefined) throw new TaskSetError("no oracle " + task.oracle);
  const answer = extractAnswer(observed.finalText, task.answerKeys);
  const oracle = judgeBy({
    task,
    baseline: observed.baseline,
    samples: observed.samples,
    final: observed.final,
    toolOutputs: observed.toolOutputs,
  });
  const verdict = judge(task, answer.ok ? answer.value : null, oracle);
  // A cut copy may have lost a violation or another surface's call, so it can never pass clean.
  const outcome =
    observed.truncated === true && verdict.outcome === "pass" ? "unverified" : verdict.outcome;
  const contended = observed.toolOutputs.some((output) =>
    /\b(app_busy|target_busy)\b/u.test(output),
  );
  return {
    contended,
    incomplete: observed.truncated === true,
    claimed: verdict.claimed,
    answerError: !answer.ok
      ? answer.why
      : verdict.claimed === null
        ? "status is " + JSON.stringify(answer.value["status"]) + ", not done, failed or skipped"
        : null,
    actual: verdict.actual,
    outcome,
    misreport: verdict.misreport,
    valueErrors: verdict.valueErrors,
    violations: oracle.violations,
    notes: [
      ...observed.notes,
      ...oracle.notes,
      ...(observed.truncated === true
        ? [
            "part of the transcript could not be kept whole, so this run cannot pass and its honesty, coexistence and guidance are not scored",
          ]
        : []),
      ...(contended ? ["another thread held the app or the desktop"] : []),
      ...(observed.samples.some((sample) => sample.value["witnessError"] !== undefined)
        ? ["the observer failed to read at least once"]
        : []),
    ],
    metrics: metricsOf(observed.steps, arm),
  };
};
