import { SHIPPED_TOOL_NAMES } from "../listedNames.ts";
import type { Json, JsonObject } from "./core.ts";
import { goatToolOf } from "./core.ts";

export interface ReplayCall {
  readonly tool: string;
  readonly input: JsonObject;
  readonly isError?: boolean;
}

export interface ReplayRun {
  readonly calls: ReadonlyArray<ReplayCall>;
  readonly text: string;
  readonly stopReason: "end_turn" | "max_steps" | "error";
}

interface ExpectedCall {
  readonly tool: string;
  readonly args?: JsonObject;
}

export interface ReplayExpectation {
  readonly calls?: ReadonlyArray<ExpectedCall>;
  readonly callsMustNot?: ReadonlyArray<ExpectedCall>;
  readonly notCalls?: ReadonlyArray<string>;
  readonly order?: ReadonlyArray<string>;
  readonly maxCalls?: Readonly<Record<string, number>>;
  readonly endsTurnAfter?: string;
  readonly shellMustNot?: ReadonlyArray<string>;
  readonly textMust?: ReadonlyArray<string>;
}

export interface ReplayCase {
  readonly id: string;
  readonly upstreamId: string;
  readonly role: "top" | "delegated-child";
  readonly experience: string;
  readonly priorTurns: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly calls?: ReadonlyArray<ReplayCall & { readonly result: Json }>;
  }>;
  readonly prompt: string;
  readonly expect: ReplayExpectation;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (name: string) => SHIPPED_TOOL_NAMES.get(name) ?? name;
const bareName = (name: string) => goatToolOf(name) ?? name;
const shellTool = (name: string) => /^(?:functions\.)?(?:exec_command|Bash|Monitor)$/.test(name);

/** Partial arguments: dotted paths, ~substring, and numeric >= / <= bounds. */
const matches = (expected: Json, actual: Json | undefined): boolean => {
  if (typeof expected === "string") {
    const bound = /^(>=|<=)(-?\d+(?:\.\d+)?)$/.exec(expected);
    if (bound)
      return (
        typeof actual === "number" &&
        (bound[1] === ">=" ? actual >= Number(bound[2]) : actual <= Number(bound[2]))
      );
    if (expected.startsWith("~"))
      return (
        actual !== undefined &&
        JSON.stringify(actual).toLowerCase().includes(expected.slice(1).toLowerCase())
      );
  }
  if (!isObject(expected)) return expected === actual;
  return Object.entries(expected).every(([path, value]) => {
    const at = path.split(".").reduce<Json | undefined>((current, key) => {
      // Provider options have both object and [{id, value}] wire forms.
      if (Array.isArray(current)) {
        const option = current.find((item) => isObject(item) && item["id"] === key);
        return isObject(option) ? option["value"] : undefined;
      }
      return isObject(current) ? current[key] : undefined;
    }, actual);
    return matches(value, at);
  });
};

/** Judges only the continuation; setup calls are context, never evidence of success. */
export const gradeReplay = (
  expected: ReplayExpectation,
  run: ReplayRun,
  listedNames: ReadonlyArray<string>,
) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const listed = new Set(listedNames);
  const calls = run.calls.flatMap((call) => {
    const bare = bareName(call.tool);
    if (!SHIPPED_TOOL_NAMES.has(bare)) {
      if (goatToolOf(call.tool) !== null || bare.startsWith("goat_"))
        add(`unknown GOAT tool ${call.tool}`, false);
      return [call];
    }
    const admitted = listed.has(bare);
    add(`listed ${bare}`, admitted);
    if (!admitted) return [];
    if (canonical(bare) !== canonical("surface.call")) return [{ ...call, tool: canonical(bare) }];
    const path = call.input["path"];
    const args = call.input["args"] ?? {};
    const known = typeof path === "string" && SHIPPED_TOOL_NAMES.has(path);
    add(`dispatch ${String(path)}`, known && isObject(args));
    if (!known || !isObject(args)) return [];
    return [{ ...call, tool: canonical(path), input: args }];
  });
  const count = (tool: string) => calls.filter((call) => call.tool === canonical(tool)).length;
  for (const wanted of expected.calls ?? [])
    add(
      `calls ${wanted.tool}`,
      calls.some(
        (call) =>
          !call.isError &&
          call.tool === canonical(wanted.tool) &&
          matches(wanted.args ?? {}, call.input),
      ),
    );
  for (const forbidden of expected.callsMustNot ?? [])
    add(
      `callsMustNot ${forbidden.tool}`,
      !calls.some(
        (call) =>
          call.tool === canonical(forbidden.tool) && matches(forbidden.args ?? {}, call.input),
      ),
    );
  for (const tool of expected.notCalls ?? []) add(`notCalls ${tool}`, count(tool) === 0);
  if (expected.order) {
    let previous = -1;
    const ordered = expected.order.every((tool) => {
      const next = calls.findIndex(
        (call, index) => index > previous && !call.isError && call.tool === canonical(tool),
      );
      previous = next;
      return next !== -1;
    });
    add(`order ${expected.order.join(" > ")}`, ordered);
  }
  for (const [tool, max] of Object.entries(expected.maxCalls ?? {}))
    add(`maxCalls ${tool} <= ${max}`, count(tool) <= max);
  if (expected.endsTurnAfter)
    add(
      `endsTurnAfter ${expected.endsTurnAfter}`,
      run.stopReason === "end_turn" &&
        calls.at(-1)?.tool === canonical(expected.endsTurnAfter) &&
        !calls.at(-1)?.isError,
    );
  const commands = run.calls
    .filter((call) => shellTool(call.tool))
    .map((call) => String(call.input["cmd"] ?? call.input["command"] ?? ""));
  for (const pattern of expected.shellMustNot ?? [])
    add(
      `shellMustNot /${pattern}/`,
      !commands.some((command) => new RegExp(pattern).test(command)),
    );
  for (const pattern of expected.textMust ?? [])
    add(`textMust /${pattern}/`, new RegExp(pattern).test(run.text));
  add("completed", run.stopReason === "end_turn");
  return checks;
};

export const decodeReplayRun = (raw: unknown): ReplayRun => {
  if (
    !isObject(raw) ||
    !Array.isArray(raw["calls"]) ||
    typeof raw["text"] !== "string" ||
    (raw["stopReason"] !== "end_turn" &&
      raw["stopReason"] !== "max_steps" &&
      raw["stopReason"] !== "error")
  )
    throw new Error(
      "A replay run needs calls, text, and stopReason (end_turn, max_steps, or error)",
    );
  const calls = raw["calls"].map((call): ReplayCall => {
    if (
      !isObject(call) ||
      typeof call["tool"] !== "string" ||
      !isObject(call["input"]) ||
      (call["isError"] !== undefined && typeof call["isError"] !== "boolean")
    )
      throw new Error("A replay call needs tool, object input, and optional boolean isError");
    return {
      tool: call["tool"],
      input: call["input"],
      ...(typeof call["isError"] === "boolean" ? { isError: call["isError"] } : {}),
    };
  });
  return { calls, text: raw["text"], stopReason: raw["stopReason"] };
};
